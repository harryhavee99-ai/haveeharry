import fs from 'fs';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import type {
  ClipCategory,
  ClipScoreBreakdown,
  SceneMarker,
  TranscriptSegment,
  WordTiming,
} from '../shared/types.ts';

function getClient(apiVersion: 'v1beta' | 'v1' = 'v1beta'): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please configure your Gemini API key in Settings > Secrets to enable AI transcription and highlight selection.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key.trim().length > 10 && key !== 'MY_GEMINI_API_KEY');
}

function parseJsonSafely<T>(rawText: string | undefined, fallback: T): T {
  const raw = (rawText ?? '').trim();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Attempt to extract first JSON object or array if model wrapped output in text
    const objStart = cleaned.indexOf('{');
    const arrStart = cleaned.indexOf('[');
    const start =
      objStart >= 0 && arrStart >= 0 ? Math.min(objStart, arrStart) : Math.max(objStart, arrStart);
    if (start >= 0) {
      const endChar = cleaned[start] === '[' ? ']' : '}';
      const end = cleaned.lastIndexOf(endChar);
      if (end > start) {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      }
    }
    throw new Error('Malformed JSON returned by AI service.');
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Do not retry on invalid API key, permission denied, invalid request schema, or missing model
      if (
        msg.includes('API_KEY_INVALID') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('INVALID_ARGUMENT') ||
        msg.includes('NOT_FOUND') ||
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('404') ||
        msg.includes('not configured')
      ) {
        throw err;
      }
      if (attempt < maxAttempts) {
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const baseDelay = isRateLimit ? 2500 : 1200;
        const backoff = Math.min(20000, baseDelay * Math.pow(2, attempt - 1));
        const jitter = Math.round(Math.random() * 400);
        await new Promise((r) => setTimeout(r, backoff + jitter));
      }
    }
  }
  throw lastError;
}

/**
 * Distributes word-level timestamps proportionally across a segment based on syllable/character weight
 * when exact per-word boundaries are not returned, or normalizes returned word timestamps to stay strictly within [segStart, segEnd].
 */
function buildWordTimings(
  text: string,
  segStart: number,
  segEnd: number,
  rawWords?: Array<{ word: string; start?: number; end?: number }>
): WordTiming[] {
  const duration = Math.max(0.2, segEnd - segStart);
  if (rawWords && rawWords.length > 0) {
    const cleaned = rawWords
      .map((w) => ({
        word: String(w.word ?? '').trim(),
        start: typeof w.start === 'number' && Number.isFinite(w.start) ? w.start : undefined,
        end: typeof w.end === 'number' && Number.isFinite(w.end) ? w.end : undefined,
      }))
      .filter((w) => w.word.length > 0);

    if (cleaned.length > 0 && cleaned.every((w) => w.start !== undefined && w.end !== undefined)) {
      return cleaned.map((w) => ({
        id: uuidv4(),
        word: w.word,
        start: Math.max(segStart, Math.min(segEnd, w.start!)),
        end: Math.max(segStart, Math.min(segEnd, Math.max(w.start! + 0.05, w.end!))),
      }));
    }
  }

  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (tokens.length === 0) return [];

  const weights = tokens.map((t) => Math.max(1.5, t.replace(/[^a-zA-Z0-9\u0600-\u06FF\u0900-\u097F]/g, '').length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let cursor = segStart;
  return tokens.map((word, idx) => {
    const share = (weights[idx] / totalWeight) * duration;
    const start = Number(cursor.toFixed(3));
    const end = Number((idx === tokens.length - 1 ? segEnd : cursor + share).toFixed(3));
    cursor += share;
    return {
      id: uuidv4(),
      word,
      start,
      end: Math.max(start + 0.04, end),
    };
  });
}

export interface ChunkTranscriptionResult {
  detectedLanguage: string;
  segments: TranscriptSegment[];
}

function parseTimestampedTranscriptLines(
  rawText: string,
  chunkIndex: number,
  chunkOffsetSeconds: number,
  chunkDurationSeconds: number
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const parseSec = (val: string): number => {
    const clean = val.trim().replace(/s$/i, '');
    if (clean.includes(':')) {
      const parts = clean.split(':').map(Number);
      if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
      if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    const n = Number(clean);
    return Number.isFinite(n) ? n : NaN;
  };

  // Matches formats like: [0.0 - 5.2] Speaker 1: Hello world  OR  [00:00 - 00:05] Hello world
  const lineRe = /^\[?\s*([0-9:.]+s?)\s*[-–—to]+\s*([0-9:.]+s?)\s*\]?\s*(?:([^:]{1,28}):\s*)?(.+)$/i;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const rawStart = parseSec(m[1]);
    const rawEnd = parseSec(m[2]);
    const speaker = (m[3] || 'Speaker 1').trim();
    const text = m[4].trim();
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || !text || text === '[NO_SPEECH]') continue;
    const localStart = Math.max(0, Math.min(chunkDurationSeconds - 0.1, rawStart));
    const localEnd = Math.max(localStart + 0.25, Math.min(chunkDurationSeconds, rawEnd));
    const absStart = Number((chunkOffsetSeconds + localStart).toFixed(3));
    const absEnd = Number((chunkOffsetSeconds + localEnd).toFixed(3));
    segments.push({
      id: uuidv4(),
      start: absStart,
      end: absEnd,
      speaker,
      text,
      words: buildWordTimings(text, absStart, absEnd),
      chunkIndex,
    });
  }
  return segments;
}

/**
 * Transcribes a single audio chunk using Gemini 3.5 Transcribe (verbatim spoken speech)
 * with fast single-pass timestamp parsing and Gemini 4 Hydrogen structured fallback alignment.
 */
export async function transcribeAudioChunk(params: {
  audioPath: string;
  chunkIndex: number;
  chunkOffsetSeconds: number;
  chunkDurationSeconds: number;
  language: string;
}): Promise<ChunkTranscriptionResult> {
  const ai = getClient('v1beta');
  const audioBuffer = fs.readFileSync(params.audioPath);
  const base64Audio = audioBuffer.toString('base64');

  const languageDirective =
    params.language === 'auto'
      ? 'Detect the spoken language automatically and transcribe verbatim in the original spoken language.'
      : params.language === 'roman_ur'
        ? 'Transcribe the spoken Urdu/Hindi verbatim using Roman Urdu (Latin script) with natural punctuation and capitalization.'
        : `Transcribe the spoken audio verbatim in language code "${params.language}" with accurate punctuation and capitalization.`;

  // Step 1: Fast single-pass timestamped speech-to-text via gemini-3.5-transcribe
  let verbatimReference = '';
  try {
    const t0 = Date.now();
    const transcribeRes = await withRetry(
      () =>
        ai.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/mp3',
                  data: base64Audio,
                },
              },
              {
                text: [
                  `${languageDirective}`,
                  `Audio duration is ${params.chunkDurationSeconds.toFixed(1)} seconds (0.0 to ${params.chunkDurationSeconds.toFixed(1)}).`,
                  `Format each spoken sentence/phrase on its own line with exact timestamps in seconds like:`,
                  `[0.0 - 4.5] Speaker 1: Exact spoken words here.`,
                  `Only transcribe words actually spoken in the audio. If there is silence or only music with no speech, respond with "[NO_SPEECH]".`,
                ].join('\n'),
              },
            ],
          },
        }),
      2
    );
    verbatimReference = (transcribeRes.text ?? '').trim();
    console.log(
      `[Gemini] gemini-3.5-transcribe chunk ${params.chunkIndex} finished in ${Date.now() - t0}ms (${verbatimReference.length} chars)`
    );
  } catch (err) {
    console.warn('gemini-3.5-transcribe fallback to gemini-4-hydrogen audio pass:', err);
  }

  if (verbatimReference === '[NO_SPEECH]') {
    return { detectedLanguage: params.language === 'auto' ? 'en' : params.language, segments: [] };
  }

  // Fast path: if gemini-3.5-transcribe already returned clean timestamped segments, skip second heavy audio pass!
  if (verbatimReference) {
    const directSegments = parseTimestampedTranscriptLines(
      verbatimReference,
      params.chunkIndex,
      params.chunkOffsetSeconds,
      params.chunkDurationSeconds
    );
    if (directSegments.length > 0) {
      return {
        detectedLanguage: params.language === 'auto' ? 'en' : params.language,
        segments: directSegments,
      };
    }
  }

  // Step 2: Structured timestamped diarized alignment via gemini-4-hydrogen (fallback when Step 1 had no timestamps)
  const prompt = [
    `You are a precision speech-to-text timestamp aligner.`,
    `This audio chunk is ${params.chunkDurationSeconds.toFixed(1)} seconds long (local timestamps from 0.0 to ${params.chunkDurationSeconds.toFixed(1)} seconds).`,
    languageDirective,
    verbatimReference
      ? `Verbatim ASR reference transcript (use this as ground truth so you never invent dialogue):\n"""\n${verbatimReference}\n"""`
      : 'Transcribe only words genuinely spoken in the audio. NEVER invent or hallucinate speech.',
    `Return timestamped sentence/phrase segments (ideally 2 to 8 seconds each) with speaker labels (e.g., "Speaker 1", "Speaker 2"), accurate start/end seconds within [0, ${params.chunkDurationSeconds.toFixed(1)}], and natural punctuation.`,
    `If there is no spoken dialogue in this audio chunk, return an empty segments array.`,
  ].join('\n\n');

  const t1 = Date.now();
  const parsed = await withRetry(async () => {
    const alignedRes = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'audio/mp3',
              data: base64Audio,
            },
          },
          { text: prompt },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedLanguage: {
              type: Type.STRING,
              description: 'ISO language code or name of the spoken audio.',
            },
            segments: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER, description: 'Start time in seconds relative to chunk start' },
                  end: { type: Type.NUMBER, description: 'End time in seconds relative to chunk start' },
                  speaker: { type: Type.STRING, description: 'Speaker label such as Speaker 1' },
                  text: { type: Type.STRING, description: 'Exact spoken words with punctuation' },
                },
                required: ['start', 'end', 'speaker', 'text'],
              },
            },
          },
          required: ['detectedLanguage', 'segments'],
        },
      },
    });

    return parseJsonSafely<{
      detectedLanguage?: string;
      segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
    }>(alignedRes.text, { detectedLanguage: params.language === 'auto' ? 'en' : params.language, segments: [] });
  }, 3);
  console.log(
    `[Gemini] gemini-4-hydrogen alignment chunk ${params.chunkIndex} finished in ${Date.now() - t1}ms (${parsed.segments?.length ?? 0} segs)`
  );

  const segments: TranscriptSegment[] = (parsed.segments ?? [])
    .filter((s) => s.text && s.text.trim().length > 0 && s.text.trim() !== '[NO_SPEECH]')
    .map((s) => {
      const localStart = Math.max(0, Math.min(params.chunkDurationSeconds - 0.1, Number(s.start) || 0));
      const localEnd = Math.max(
        localStart + 0.25,
        Math.min(params.chunkDurationSeconds, Number(s.end) || localStart + 2)
      );
      const absStart = Number((params.chunkOffsetSeconds + localStart).toFixed(3));
      const absEnd = Number((params.chunkOffsetSeconds + localEnd).toFixed(3));
      const cleanText = s.text.trim();
      return {
        id: uuidv4(),
        start: absStart,
        end: absEnd,
        speaker: (s.speaker || 'Speaker 1').trim(),
        text: cleanText,
        words: buildWordTimings(cleanText, absStart, absEnd),
        chunkIndex: params.chunkIndex,
      };
    });

  return {
    detectedLanguage: parsed.detectedLanguage || (params.language === 'auto' ? 'en' : params.language),
    segments,
  };
}

/**
 * Analyzes sampled video keyframes with Gemini 4 Hydrogen to determine active speaker focal point (X, Y)
 * and scene descriptions for intelligent 9:16 Auto Reframe and Face Tracking.
 */
export async function analyzeKeyframesForFraming(
  keyframes: Array<{ time: number; filePath: string }>
): Promise<Array<{ time: number; speakerX: number; speakerY: number; description: string }>> {
  if (keyframes.length === 0) return [];
  const ai = getClient('v1beta');

  // Sample up to 6 representative keyframes across the video to keep multimodal latency crisp
  const step = Math.max(1, Math.floor(keyframes.length / 6));
  const selected = keyframes.filter((_, i) => i % step === 0).slice(0, 6);

  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
  selected.forEach((kf, idx) => {
    if (fs.existsSync(kf.filePath)) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: fs.readFileSync(kf.filePath).toString('base64'),
        },
      });
      parts.push({ text: `Frame #${idx} at timestamp ${kf.time.toFixed(1)}s` });
    }
  });

  if (parts.length === 0) return [];

  parts.push({
    text:
      'For each numbered video frame above, estimate the primary active speaker or subject focal point normalized coordinates: speakerX (0.0 left edge to 1.0 right edge, default 0.5 if centered or no face), speakerY (0.0 top edge to 1.0 bottom edge, default 0.42), and a concise 5-10 word visual description.',
  });

  try {
    const t0 = Date.now();
    const parsed = await withRetry(async () => {
      const res = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                frameIndex: { type: Type.INTEGER },
                speakerX: { type: Type.NUMBER },
                speakerY: { type: Type.NUMBER },
                description: { type: Type.STRING },
              },
              required: ['frameIndex', 'speakerX', 'speakerY', 'description'],
            },
          },
        },
      });
      const data = parseJsonSafely<
        Array<{
          frameIndex: number;
          speakerX: number;
          speakerY: number;
          description: string;
        }>
      >(res.text, []);
      if (!Array.isArray(data)) {
        throw new Error('Keyframe framing response was not an array.');
      }
      return data;
    }, 2);
    console.log(`[Gemini] visual framing (${selected.length} frames) finished in ${Date.now() - t0}ms`);

    return parsed
      .filter((item) => item.frameIndex >= 0 && item.frameIndex < selected.length)
      .map((item) => ({
        time: selected[item.frameIndex].time,
        speakerX: Math.max(0.15, Math.min(0.85, Number(item.speakerX) || 0.5)),
        speakerY: Math.max(0.15, Math.min(0.85, Number(item.speakerY) || 0.45)),
        description: item.description || 'Video frame',
      }));
  } catch (err) {
    console.warn('Keyframe visual framing analysis failed, using centered defaults:', err);
    return selected.map((kf) => ({
      time: kf.time,
      speakerX: 0.5,
      speakerY: 0.45,
      description: 'Detected scene frame',
    }));
  }
}

export interface SelectedHighlight {
  title: string;
  description: string;
  reasonSelected: string;
  category: ClipCategory;
  startTime: number;
  endTime: number;
  hookTitle: string;
  speakerLabel: string;
  emphasizedKeywords: string[];
  scores: ClipScoreBreakdown;
}

/**
 * Selects the strongest non-overlapping highlights from the full timestamped transcript + visual scenes.
 * Supports multi-hour transcripts by batching into windows when transcript exceeds 25,000 characters.
 */
export async function selectHighlightsWithGemini(params: {
  transcript: TranscriptSegment[];
  scenes: SceneMarker[];
  videoDuration: number;
  targetDuration: number;
  desiredCount: number; // 0 means maximum possible non-overlapping
  excludeRanges?: Array<{ start: number; end: number }>;
  customFocusPrompt?: string;
}): Promise<SelectedHighlight[]> {
  const ai = getClient();

  // Compute realistic target clip duration if source video is shorter than requested clip length
  const effectiveTarget =
    params.videoDuration <= params.targetDuration
      ? Math.max(8, Math.min(params.videoDuration, Math.round(params.videoDuration * 0.45)))
      : params.targetDuration;

  const maxPossible = Math.max(1, Math.min(30, Math.floor(params.videoDuration / Math.max(12, effectiveTarget * 0.65))));
  const requestedCount =
    params.desiredCount === 0
      ? maxPossible
      : Math.max(1, Math.min(params.desiredCount, maxPossible));

  const transcriptLines = params.transcript.map(
    (seg) => `[${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s] (${seg.speaker}): ${seg.text}`
  );

  // If transcript is empty (e.g. silent/visual-only footage), build scene-based context
  const hasSpeech = transcriptLines.length > 0;
  const fullTranscriptText = hasSpeech
    ? transcriptLines.join('\n')
    : `No spoken dialogue detected. Video duration is ${params.videoDuration.toFixed(1)} seconds. Detected scene visual summaries:\n` +
      params.scenes
        .map((s) => `[${s.time.toFixed(1)}s] ${s.description || 'Visual scene change'}`)
        .join('\n');

  // Chunk very long multi-hour transcripts into map-reduce windows (~18k chars each)
  const MAX_CHARS = 18000;
  const windows: string[] = [];
  if (fullTranscriptText.length <= MAX_CHARS) {
    windows.push(fullTranscriptText);
  } else {
    let buffer = '';
    for (const line of transcriptLines) {
      if (buffer.length + line.length + 1 > MAX_CHARS) {
        windows.push(buffer);
        buffer = line;
      } else {
        buffer += (buffer ? '\n' : '') + line;
      }
    }
    if (buffer) windows.push(buffer);
  }

  const perWindowTarget = Math.max(
    1,
    Math.ceil((requestedCount * 1.4) / windows.length)
  );

  const excludeNote =
    params.excludeRanges && params.excludeRanges.length > 0
      ? `Avoid overlapping with these already-used time ranges: ${params.excludeRanges
          .map((r) => `${r.start.toFixed(1)}s-${r.end.toFixed(1)}s`)
          .join(', ')}.`
      : '';

  const allCandidates: SelectedHighlight[] = [];

  for (const windowText of windows) {
    const prompt = [
      `You are an elite short-form video editor and content strategist.`,
      `Total source video duration: ${params.videoDuration.toFixed(1)} seconds.`,
      `Task: Select ${perWindowTarget} distinct, non-overlapping highlight clips from the transcript/scene log below.`,
      `Target clip duration: approximately ${effectiveTarget} seconds (acceptable window: ${Math.max(8, Math.round(effectiveTarget * 0.6))}s to ${Math.min(params.videoDuration, Math.round(effectiveTarget * 1.35))}s).`,
      `Selection criteria:`,
      `- Prioritize strong opening hooks, interesting conversations, powerful statements, educational explanations, emotional or funny peaks, storytelling highlights, Q&A exchanges, and memorable conclusions.`,
      `- Every clip MUST have a complete beginning, middle, and ending. NEVER cut mid-sentence. Snap startTime and endTime to the exact timestamps of the transcript segments.`,
      `- Clips must stand alone and make complete sense without watching the full original video.`,
      `- Scores are AI-generated quality estimates (0-100), NOT viral performance guarantees.`,
      excludeNote,
      params.customFocusPrompt ? `User focus instruction: ${params.customFocusPrompt}` : '',
      `Transcript / Scene Log:\n${windowText}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const parsed = await withRetry(async () => {
      const res = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: 'Compelling concise clip title (4-9 words)' },
                description: { type: Type.STRING, description: '2-sentence viewer-facing summary of the clip' },
                reasonSelected: {
                  type: Type.STRING,
                  description: 'Concise editorial explanation of why AI chose this moment (hook, insight, story arc)',
                },
                category: {
                  type: Type.STRING,
                  description:
                    'One of: interesting, educational, funny, emotional, informative, storytelling, debate, hook',
                },
                startTime: { type: Type.NUMBER, description: 'Start timestamp in seconds' },
                endTime: { type: Type.NUMBER, description: 'End timestamp in seconds' },
                hookTitle: { type: Type.STRING, description: 'Short 2-5 word on-screen hook title' },
                speakerLabel: { type: Type.STRING, description: 'Main speaker name or label' },
                emphasizedKeywords: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '2-4 key spoken words from this clip to highlight visually',
                },
                scores: {
                  type: Type.OBJECT,
                  properties: {
                    overall: { type: Type.INTEGER },
                    hookStrength: { type: Type.INTEGER },
                    engagement: { type: Type.INTEGER },
                    educationalValue: { type: Type.INTEGER },
                    emotionalImpact: { type: Type.INTEGER },
                    humor: { type: Type.INTEGER },
                    informationValue: { type: Type.INTEGER },
                    storyCompleteness: { type: Type.INTEGER },
                  },
                  required: [
                    'overall',
                    'hookStrength',
                    'engagement',
                    'educationalValue',
                    'emotionalImpact',
                    'humor',
                    'informationValue',
                    'storyCompleteness',
                  ],
                },
              },
              required: [
                'title',
                'description',
                'reasonSelected',
                'category',
                'startTime',
                'endTime',
                'hookTitle',
                'speakerLabel',
                'emphasizedKeywords',
                'scores',
              ],
            },
          },
        },
      });
      const data = parseJsonSafely<SelectedHighlight[]>(res.text, []);
      if (!Array.isArray(data)) {
        throw new Error('Highlight selection response was not an array.');
      }
      return data;
    });

    for (const item of parsed) {
      const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(Number(n) || 70)));
      const minClipLen = Math.min(4, Math.max(1, params.videoDuration * 0.5));
      const startTime = Math.max(0, Math.min(Math.max(0, params.videoDuration - minClipLen), Number(item.startTime) || 0));
      const endTime = Math.max(
        startTime + minClipLen,
        Math.min(params.videoDuration, Number(item.endTime) || startTime + effectiveTarget)
      );
      const validCategories: ClipCategory[] = [
        'interesting',
        'educational',
        'funny',
        'emotional',
        'informative',
        'storytelling',
        'debate',
        'hook',
      ];
      const category = validCategories.includes(item.category) ? item.category : 'interesting';
      allCandidates.push({
        title: (item.title || 'Highlight Clip').trim(),
        description: (item.description || '').trim(),
        reasonSelected: (item.reasonSelected || 'Strong standalone narrative moment with clear framing.').trim(),
        category,
        startTime: Number(startTime.toFixed(2)),
        endTime: Number(endTime.toFixed(2)),
        hookTitle: (item.hookTitle || item.title || '').trim().slice(0, 48),
        speakerLabel: (item.speakerLabel || 'Speaker 1').trim(),
        emphasizedKeywords: Array.isArray(item.emphasizedKeywords)
          ? item.emphasizedKeywords.slice(0, 5).map((k) => String(k).trim()).filter(Boolean)
          : [],
        scores: {
          overall: clamp(item.scores?.overall),
          hookStrength: clamp(item.scores?.hookStrength),
          engagement: clamp(item.scores?.engagement),
          educationalValue: clamp(item.scores?.educationalValue),
          emotionalImpact: clamp(item.scores?.emotionalImpact),
          humor: clamp(item.scores?.humor),
          informationValue: clamp(item.scores?.informationValue),
          storyCompleteness: clamp(item.scores?.storyCompleteness),
        },
      });
    }
  }

  // Deduplicate overlapping clips, keeping the highest-scored moments
  const sorted = allCandidates.sort((a, b) => b.scores.overall - a.scores.overall);
  const chosen: SelectedHighlight[] = [];
  for (const cand of sorted) {
    if (chosen.length >= requestedCount) break;
    const overlaps = chosen.some((existing) => {
      const overlapStart = Math.max(existing.startTime, cand.startTime);
      const overlapEnd = Math.min(existing.endTime, cand.endTime);
      const overlapDur = Math.max(0, overlapEnd - overlapStart);
      const minDur = Math.min(existing.endTime - existing.startTime, cand.endTime - cand.startTime);
      return overlapDur > minDur * 0.35;
    });
    if (!overlaps) {
      chosen.push(cand);
    }
  }

  return chosen;
}

/**
 * Generates real spoken narration WAV audio via Gemini TTS for the optional "Generate Test Video" feature
 * so users without local footage can immediately test the entire real FFmpeg + Gemini pipeline end-to-end.
 */
export async function generateSampleSpokenAudio(outWavPath: string): Promise<void> {
  const ai = getClient();
  const script = [
    'Welcome back to Creator Craft. Today I want to share the three biggest lessons I learned after editing over four hundred long-form podcasts into short-form videos.',
    'First, the opening two seconds decide everything. Most creators start with a slow greeting, and viewers swipe away before the real story even begins. Instead, open directly with the sharpest insight or surprising question.',
    'Second, captions are not just accessibility anymore, they are visual pacing. When key words pop in sync with your voice, viewers stay locked in even when watching with sound muted on their commute.',
    'And third, never sacrifice context for speed. A forty-five second clip with a complete beginning, tension, and memorable payoff will always outperform a rushed fifteen second fragment that leaves people confused.',
    'Start applying these three habits to your next recording, and watch how much more cohesive your short-form library becomes.',
  ].join(' ');

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: script,
              speechMetadata: {
                style: 'Clear, engaging, natural podcast host with warm studio delivery',
              },
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    })
  );

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('Gemini TTS did not return audio data.');
  }
  fs.writeFileSync(outWavPath, Buffer.from(base64Audio, 'base64'));
}
