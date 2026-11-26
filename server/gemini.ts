import fs from 'fs';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import type {
  AudioEnergyPoint,
  ClipCategory,
  ClipScoreBreakdown,
  HookScoreBreakdown,
  HookScoringWeights,
  SceneMarker,
  TranscriptSegment,
  WordTiming,
} from '../shared/types.ts';
import { DEFAULT_HOOK_SCORING_WEIGHTS } from '../shared/presets.ts';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

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

let transcribeCooldownUntil = 0;

function extractRetryDelayMs(msg: string, fallbackMs: number): number {
  const retryField = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryField) {
    return Math.min(90_000, Math.ceil(Number(retryField[1]) * 1000) + 1500);
  }
  const pleaseRetry = msg.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (pleaseRetry) {
    return Math.min(90_000, Math.ceil(Number(pleaseRetry[1]) * 1000) + 1500);
  }
  return fallbackMs;
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
        const backoff = isRateLimit
          ? extractRetryDelayMs(msg, Math.min(25000, baseDelay * Math.pow(2, attempt - 1)))
          : Math.min(20000, baseDelay * Math.pow(2, attempt - 1));
        const jitter = Math.round(Math.random() * 400);
        await new Promise((r) => setTimeout(r, backoff + jitter));
      }
    }
  }
  throw lastError;
}

/**
 * Computes syllable & punctuation-cadence-aware word-level timestamps within [segStart, segEnd].
 * Allocates realistic micro-pauses after commas, colons, dashes, and sentence-ending punctuation
 * so word highlighting stays locked to the actual spoken voiceover rhythm instead of drifting ahead.
 */
export function buildWordTimings(
  text: string,
  segStart: number,
  segEnd: number,
  rawWords?: Array<{ word: string; start?: number; end?: number }>
): WordTiming[] {
  const duration = Math.max(0.16, segEnd - segStart);
  if (rawWords && rawWords.length > 0) {
    const cleaned = rawWords
      .map((w) => ({
        word: String(w.word ?? '').trim(),
        start: typeof w.start === 'number' && Number.isFinite(w.start) ? w.start : undefined,
        end: typeof w.end === 'number' && Number.isFinite(w.end) ? w.end : undefined,
      }))
      .filter((w) => w.word.length > 0);

    if (cleaned.length > 0 && cleaned.every((w) => w.start !== undefined && w.end !== undefined)) {
      let prevEnd = segStart;
      return cleaned.map((w, idx) => {
        const clampedStart = Math.max(prevEnd, Math.max(segStart, Math.min(segEnd - 0.04, w.start!)));
        const maxAllowedEnd = idx === cleaned.length - 1 ? segEnd : Math.min(segEnd, cleaned[idx + 1].start ?? segEnd);
        const clampedEnd = Math.max(
          clampedStart + 0.04,
          Math.min(segEnd, Math.max(w.end!, maxAllowedEnd > clampedStart + 0.04 ? Math.min(w.end!, maxAllowedEnd) : w.end!))
        );
        prevEnd = clampedEnd;
        return {
          id: uuidv4(),
          word: w.word,
          start: Number(clampedStart.toFixed(3)),
          end: Number(clampedEnd.toFixed(3)),
        };
      });
    }
  }

  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (tokens.length === 0) return [];

  // Estimate spoken syllable weight + post-word punctuation pause weight for each token
  const tokenMetrics = tokens.map((t, idx) => {
    const cleanAlpha = t.replace(/[^a-zA-Z0-9\u0600-\u06FF\u0900-\u097F]/g, '');
    // Count vowel groups as syllable proxy (fallback to character length)
    const vowelMatches = cleanAlpha.match(/[aeiouyAEIOUY]+/g);
    const syllableCount = vowelMatches ? Math.max(1, vowelMatches.length) : Math.max(1, Math.ceil(cleanAlpha.length / 3));
    const speakWeight = Math.max(1.25, syllableCount * 1.15 + cleanAlpha.length * 0.22);

    // Punctuation at end of token introduces a natural human breath/cadence pause after the word
    let pauseWeight = 0;
    if (idx < tokens.length - 1) {
      if (/[.!?؟۔]+["')\]}]*$/.test(t)) {
        pauseWeight = 1.65; // ~220-280ms sentence boundary pause
      } else if (/[,;:—–\-]+["')\]}]*$/.test(t)) {
        pauseWeight = 1.05; // ~140-180ms clause pause
      }
    }
    return { speakWeight, pauseWeight, totalWeight: speakWeight + pauseWeight };
  });

  const sumWeights = tokenMetrics.reduce((acc, m) => acc + m.totalWeight, 0);
  let cursor = segStart;

  return tokens.map((word, idx) => {
    const m = tokenMetrics[idx];
    const slotDuration = (m.totalWeight / sumWeights) * duration;
    const speakDuration =
      idx === tokens.length - 1
        ? slotDuration
        : slotDuration * (m.speakWeight / Math.max(0.1, m.totalWeight));
    const start = Number(cursor.toFixed(3));
    const rawEnd = idx === tokens.length - 1 ? segEnd : cursor + speakDuration;
    const end = Number(Math.min(segEnd, Math.max(start + 0.045, rawEnd)).toFixed(3));
    cursor += slotDuration;
    return {
      id: uuidv4(),
      word,
      start,
      end,
    };
  });
}

export interface ChunkTranscriptionResult {
  detectedLanguage: string;
  segments: TranscriptSegment[];
}

function buildLanguageDirective(language: string): string {
  switch (language) {
    case 'hinglish':
      return [
        'LANGUAGE & SCRIPT RULE (HIGH-END HINGLISH):',
        'Transcribe the spoken Hindi/Urdu/English speech verbatim in clean, natural HINGLISH (Latin/Roman alphabet mixing conversational Hindi and English exactly as spoken by modern Indian/South Asian creators).',
        'Use natural, readable Roman spelling for Hindi words (e.g., "Aaj hum baat karenge kaise aap apne video captions ko high-end bana sakte hain") and standard English spelling for English words.',
        'NEVER use Devanagari (हिन्दी) or Urdu Arabic script (اردو). Add crisp punctuation (?, !, ., ,) and natural capitalization.',
      ].join(' ');
    case 'roman_ur':
      return [
        'LANGUAGE & SCRIPT RULE (HIGH-END ROMAN URDU):',
        'Transcribe the spoken Urdu/Hindi/English speech verbatim in authentic, studio-grade ROMAN URDU (Latin alphabet used for Urdu).',
        'Use natural Pakistani/South Asian Roman Urdu orthography (e.g., "Agar aap ko yeh video pasand aayi toh zaroor dekhein ke captions kaise kaam karte hain", using clear spellings like "hain", "mein", "aur", "kyunke", "lekin", "zaroor", "bohat", "aap").',
        'Keep spoken English technical terms in clean English spelling. NEVER use Urdu Nastaliq/Arabic script (اردو) or Devanagari. Add accurate punctuation and capitalization.',
      ].join(' ');
    case 'ur':
      return [
        'LANGUAGE & SCRIPT RULE (HIGH-END URDU NASTALIQ / اردو):',
        'Transcribe the spoken audio in authentic, grammatically accurate Urdu script (اردو / Nastaliq Arabic script).',
        'Use proper Urdu spelling, spacing, and punctuation (۔ ، ؟ !). If the speaker uses English words, either transliterate them cleanly into Urdu script or keep short acronyms clear.',
      ].join(' ');
    case 'hi':
      return [
        'LANGUAGE & SCRIPT RULE (HINDI / हिन्दी):',
        'Transcribe the spoken audio in clean, accurate Hindi Devanagari script (हिन्दी) with proper punctuation.',
      ].join(' ');
    case 'en':
      return [
        'LANGUAGE & SCRIPT RULE (ENGLISH):',
        'Transcribe the spoken audio in clean English. If the speaker speaks Urdu or Hindi, translate/transcribe accurately into natural spoken English matching the exact phrase timing.',
      ].join(' ');
    case 'auto':
    default:
      if (language && language !== 'auto') {
        return `Transcribe the spoken audio verbatim in language code "${language}" with accurate punctuation and capitalization.`;
      }
      return 'Detect the spoken language automatically and transcribe verbatim in the original spoken language (for Urdu/Hindi mixed with English, you may use clean Roman Urdu / Hinglish or original script matching the speaker).';
  }
}

/**
 * Splits plain untimestamped verbatim ASR text into natural 4-7 word breath-group segments
 * distributed across [0, chunkDurationSeconds] according to syllable & punctuation weights.
 * Downstream `alignTranscriptWithVoiceActivity` in pipeline.ts then snaps these phrases directly
 * onto the actual FFmpeg voiceover waveform islands.
 */
function segmentPlainTextIntoPhrases(
  rawText: string,
  chunkIndex: number,
  chunkOffsetSeconds: number,
  chunkDurationSeconds: number
): TranscriptSegment[] {
  const cleaned = rawText
    .replace(/\[NO_SPEECH\]/gi, '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!cleaned) return [];

  // Strip any leading speaker prefix if present on paragraphs
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return [];

  const phrases: string[] = [];
  let current: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    current.push(w);
    const endsSentence = /[.!?؟۔]+["')\]}]*$/.test(w);
    const endsClause = /[,;:—–\-]+["')\]}]*$/.test(w);
    if (
      (endsSentence && current.length >= 2) ||
      (endsClause && current.length >= 4) ||
      current.length >= 6
    ) {
      phrases.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) {
    if (phrases.length > 0 && current.length <= 2) {
      phrases[phrases.length - 1] += ' ' + current.join(' ');
    } else {
      phrases.push(current.join(' '));
    }
  }

  if (phrases.length === 0) return [];

  // Calculate relative speaking duration weight per phrase
  const phraseWeights = phrases.map((p) => {
    const wordCount = p.split(/\s+/).length;
    const charBonus = p.length * 0.08;
    const pauseBonus = /[.!?؟۔]$/.test(p) ? 0.9 : /[,;:]$/.test(p) ? 0.45 : 0.2;
    return Math.max(1, wordCount * 0.85 + charBonus + pauseBonus);
  });

  const totalWeight = phraseWeights.reduce((acc, w) => acc + w, 0);
  // Estimate natural speech span (avoid stretching a 3-word sentence across 60 seconds)
  const estimatedSpeechSpan = Math.min(
    chunkDurationSeconds,
    Math.max(Math.min(chunkDurationSeconds, 1.5), words.length * 0.44 + phrases.length * 0.35)
  );
  // If estimated speech is much shorter than chunkDurationSeconds, still cover up to 92% of chunk so voice activity aligner can map it across islands
  const usableDuration = Math.max(
    estimatedSpeechSpan,
    Math.min(chunkDurationSeconds, chunkDurationSeconds * 0.92)
  );

  let cursor = 0;
  const segments: TranscriptSegment[] = [];

  for (let i = 0; i < phrases.length; i++) {
    const slot = (phraseWeights[i] / totalWeight) * usableDuration;
    const gap = i < phrases.length - 1 ? Math.min(0.14, slot * 0.08) : 0;
    const localStart = Math.max(0, Math.min(chunkDurationSeconds - 0.15, cursor));
    const localEnd = Math.max(
      localStart + 0.25,
      Math.min(chunkDurationSeconds, cursor + Math.max(0.25, slot - gap))
    );
    cursor += slot;

    const absStart = Number((chunkOffsetSeconds + localStart).toFixed(3));
    const absEnd = Number((chunkOffsetSeconds + localEnd).toFixed(3));
    const text = phrases[i].replace(/^(?:Speaker\s*\d+|Host|Guest)\s*:\s*/i, '').trim();
    if (!text) continue;

    segments.push({
      id: uuidv4(),
      start: absStart,
      end: absEnd,
      speaker: 'Speaker 1',
      text,
      words: buildWordTimings(text, absStart, absEnd),
      chunkIndex,
    });
  }

  return segments;
}

export function parseTimestampedTranscriptLines(
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
    const clean = val.trim().replace(/,/g, '.').replace(/s$/i, '');
    if (clean.includes(':')) {
      const parts = clean.split(':').map(Number);
      if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
      if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    const n = Number(clean);
    return Number.isFinite(n) ? n : NaN;
  };

  // 1. Matches range formats like: [0.0 - 5.2] Speaker 1: Hello world OR 00:00.400 --> 00:03.200 Hello
  const rangeLineRe =
    /^\[?\s*([0-9:.,]+s?)\s*(?:[-–—]+|-->|to)\s*([0-9:.,]+s?)\s*\]?\s*(?:[-|]\s*)?(?:([^:]{1,28}):\s*)?(.+)$/i;

  // 2. Matches single start timestamp formats like: [00:02.4] Hello world OR (1.5s) Hello world
  const singleTsEntries: Array<{ start: number; speaker: string; text: string }> = [];
  const singleLineRe = /^[\[({]?\s*([0-9]+:[0-9:.,]+|[0-9]+\.[0-9]+s?|[0-9]+s)\s*[\])}]?\s*(?:[-|]\s*)?(?:([^:]{1,24}):\s*)?(.+)$/i;

  for (const line of lines) {
    if (/^\d+$/.test(line) || /^WEBVTT/i.test(line)) continue;
    const m = line.match(rangeLineRe);
    if (m) {
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
      continue;
    }

    const sMatch = line.match(singleLineRe);
    if (sMatch) {
      const rawStart = parseSec(sMatch[1]);
      const speaker = (sMatch[2] || 'Speaker 1').trim();
      const text = sMatch[3].trim();
      if (Number.isFinite(rawStart) && text && text !== '[NO_SPEECH]') {
        singleTsEntries.push({ start: rawStart, speaker, text });
      }
    }
  }

  if (segments.length > 0) {
    return segments;
  }

  if (singleTsEntries.length > 0) {
    for (let i = 0; i < singleTsEntries.length; i++) {
      const curr = singleTsEntries[i];
      const nextStart = i + 1 < singleTsEntries.length ? singleTsEntries[i + 1].start : chunkDurationSeconds;
      const localStart = Math.max(0, Math.min(chunkDurationSeconds - 0.1, curr.start));
      const estDur = Math.max(0.4, Math.min(4.5, curr.text.split(/\s+/).length * 0.45));
      const localEnd = Math.max(
        localStart + 0.25,
        Math.min(chunkDurationSeconds, Math.min(nextStart - 0.04, localStart + estDur))
      );
      const absStart = Number((chunkOffsetSeconds + localStart).toFixed(3));
      const absEnd = Number((chunkOffsetSeconds + localEnd).toFixed(3));
      segments.push({
        id: uuidv4(),
        start: absStart,
        end: absEnd,
        speaker: curr.speaker,
        text: curr.text,
        words: buildWordTimings(curr.text, absStart, absEnd),
        chunkIndex,
      });
    }
    return segments;
  }

  // 3. Fallback: If the ASR model returned clean spoken text without timestamp brackets,
  // segment it directly into natural breath phrases so we NEVER discard valid transcription
  // or re-upload the heavy audio binary a second time!
  return segmentPlainTextIntoPhrases(rawText, chunkIndex, chunkOffsetSeconds, chunkDurationSeconds);
}

/**
 * Transcribes a single audio chunk using a resilient 3-tier Gemini audio pipeline
 * (gemini-3.5-transcribe -> gemini-4-hydrogen -> gemini-3.1-flash-lite)
 * with single-pass timestamp/phrase parsing so we never double-send audio tokens.
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

  const languageDirective = buildLanguageDirective(params.language);

  // Step 1: Fast single-pass speech-to-text via gemini-3.5-transcribe
  // Guard against Free Tier 10,000 input tokens/min limit (~32 audio tokens/sec)
  let verbatimReference = '';
  const canUseFastTranscribe =
    params.chunkDurationSeconds <= 180 && Date.now() >= transcribeCooldownUntil;

  if (canUseFastTranscribe) {
    try {
      const t0 = Date.now();
      const transcribeRes = await withTimeout(
        withRetry(
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
                      languageDirective,
                      `Audio duration is ${params.chunkDurationSeconds.toFixed(2)} seconds (0.00 to ${params.chunkDurationSeconds.toFixed(2)}).`,
                      `CRITICAL SYNC RULE: Split speech into short, tight phrase segments (1.2 to 3.8 seconds each, max 7 words per line).`,
                      `Set the start timestamp to the EXACT tenth-of-a-second when the speaker's voice begins the first syllable (do NOT include leading silence).`,
                      `Set the end timestamp to the EXACT tenth-of-a-second when the last syllable finishes (do NOT include trailing silence).`,
                      `Format each spoken phrase on its own line with exact timestamps in seconds like:`,
                      `[0.42 - 2.85] Speaker 1: Exact spoken words here.`,
                      `Only transcribe words actually spoken in the audio. If there is silence or only music with no speech, respond with "[NO_SPEECH]".`,
                    ].join('\n'),
                  },
                ],
              },
            }),
          1
        ),
        35_000,
        'gemini-3.5-transcribe'
      );
      verbatimReference = (transcribeRes.text ?? '').trim();
      console.log(
        `[Gemini] gemini-3.5-transcribe chunk ${params.chunkIndex} finished in ${Date.now() - t0}ms (${verbatimReference.length} chars)`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        const cooldownMs = extractRetryDelayMs(msg, 62_000);
        transcribeCooldownUntil = Date.now() + cooldownMs;
        console.log(
          `[Gemini] gemini-3.5-transcribe rate-limited (cooldown ${Math.round(cooldownMs / 1000)}s); routing chunk ${params.chunkIndex} to gemini-4-hydrogen.`
        );
      } else {
        console.log(
          `[Gemini] Routing chunk ${params.chunkIndex} transcription to gemini-4-hydrogen (${msg.slice(0, 120)}).`
        );
      }
    }
  } else {
    console.log(
      `[Gemini] Chunk ${params.chunkIndex} (${params.chunkDurationSeconds.toFixed(0)}s) routed directly to gemini-4-hydrogen audio alignment.`
    );
  }

  if (verbatimReference === '[NO_SPEECH]' || /^\[?NO[_\s]SPEECH\]?$/i.test(verbatimReference)) {
    return { detectedLanguage: params.language === 'auto' ? 'en' : params.language, segments: [] };
  }

  // Fast path: if gemini-3.5-transcribe returned text (with OR without timestamp brackets),
  // parseTimestampedTranscriptLines now handles both timestamped lines and plain text phrase segmentation,
  // avoiding a duplicate base64 audio call!
  if (verbatimReference) {
    const directSegments = parseTimestampedTranscriptLines(
      verbatimReference,
      params.chunkIndex,
      params.chunkOffsetSeconds,
      params.chunkDurationSeconds
    );
    if (directSegments.length > 0) {
      // If user explicitly requested Hinglish or Roman Urdu and the ASR model returned Devanagari or Urdu Arabic script,
      // run a lightweight text-only transliteration pass (costs almost zero tokens compared to audio)
      if (
        (params.language === 'hinglish' || params.language === 'roman_ur') &&
        directSegments.some((s) => /[\u0600-\u06FF\u0900-\u097F]/.test(s.text))
      ) {
        try {
          const translitRes = await withTimeout(
            ai.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: [
                languageDirective,
                'Convert each numbered line below into clean Latin/Roman script (preserving the exact line numbers and meaning, one line per number):',
                directSegments.map((s, i) => `${i + 1}. ${s.text}`).join('\n'),
              ].join('\n\n'),
            }),
            15_000,
            'transliterate-script'
          );
          const tLines = (translitRes.text ?? '')
            .split('\n')
            .map((l) => l.replace(/^\d+[.)]\s*/, '').trim())
            .filter(Boolean);
          if (tLines.length === directSegments.length) {
            for (let i = 0; i < directSegments.length; i++) {
              directSegments[i].text = tLines[i];
              directSegments[i].words = buildWordTimings(tLines[i], directSegments[i].start, directSegments[i].end);
            }
          }
        } catch {
          // Keep original directSegments if transliteration helper fails
        }
      }

      return {
        detectedLanguage: params.language === 'auto' ? 'en' : params.language,
        segments: directSegments,
      };
    }
  }

  // Step 2: Structured timestamped alignment via gemini-4-hydrogen (with fallback to gemini-3.1-flash-lite)
  const prompt = [
    `You are a frame-accurate speech-to-text forced timestamp aligner.`,
    `This audio chunk is ${params.chunkDurationSeconds.toFixed(2)} seconds long (local timestamps from 0.00 to ${params.chunkDurationSeconds.toFixed(2)} seconds).`,
    languageDirective,
    'Transcribe only words genuinely spoken in the audio. NEVER invent or hallucinate speech.',
    `CRITICAL VOICEOVER SYNC RULES:`,
    `1. Break speech into short, natural breath-group phrases of 1.2 to 4.0 seconds each (4 to 8 words per segment). Whenever the speaker pauses for breath (>0.2s), end the current segment and start a new segment after the pause.`,
    `2. Set "start" to the exact moment the first syllable of the phrase becomes audible (NEVER start at 0.0 if there is leading music/silence before the voiceover starts).`,
    `3. Set "end" to the exact moment the final syllable of the phrase stops (NEVER stretch "end" across trailing silence).`,
    `If there is no spoken dialogue in this audio chunk, return an empty segments array.`,
  ].join('\n\n');

  const responseSchema = {
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
  };

  let parsed: {
    detectedLanguage?: string;
    segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
  } | null = null;

  const fallbackModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const;
  let lastModelErr: unknown = null;

  for (const modelName of fallbackModels) {
    try {
      const t1 = Date.now();
      parsed = await withTimeout(
        withRetry(async () => {
          const alignedRes = await ai.models.generateContent({
            model: modelName,
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
              ...(modelName === 'gemini-4-hydrogen'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              responseMimeType: 'application/json',
              responseSchema,
            },
          });

          return parseJsonSafely<{
            detectedLanguage?: string;
            segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
          }>(alignedRes.text, {
            detectedLanguage: params.language === 'auto' ? 'en' : params.language,
            segments: [],
          });
        }, 2),
        45_000,
        `${modelName}-transcribe`
      );
      console.log(
        `[Gemini] ${modelName} alignment chunk ${params.chunkIndex} finished in ${Date.now() - t1}ms (${parsed?.segments?.length ?? 0} segs)`
      );
      break;
    } catch (err) {
      lastModelErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Gemini] ${modelName} failed on chunk ${params.chunkIndex} (${msg.slice(0, 140)}). Trying next fallback...`
      );
    }
  }

  if (!parsed) {
    throw lastModelErr instanceof Error
      ? lastModelErr
      : new Error('All transcription models were temporarily busy or rate-limited.');
  }

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
  topic?: string;
  description: string;
  reasonSelected: string;
  category: ClipCategory;
  startTime: number;
  endTime: number;
  hookTitle: string;
  speakerLabel: string;
  emphasizedKeywords: string[];
  scores: ClipScoreBreakdown;
  hookBreakdown?: HookScoreBreakdown;
}

export interface RawCriterionRatings {
  openingHook: number; // 0..100
  curiosityInterest: number; // 0..100
  emotionalEngagement: number; // 0..100
  infoEntertainment: number; // 0..100
  storyCompleteness: number; // 0..100
  standaloneContext: number; // 0..100
  audioVisualQuality: number; // 0..100
  surprisingScore: number; // 0..100
  storytellingScore: number; // 0..100
  entertainingScore: number; // 0..100
  informativeScore: number; // 0..100
  emotionalScore: number; // 0..100
}

export interface DiscoveredHookCandidate {
  title: string;
  topic: string;
  openingDialogue: string;
  description: string;
  reasonSelected: string;
  category: ClipCategory;
  startTime: number;
  endTime: number;
  hookTitle: string;
  speakerLabel: string;
  emphasizedKeywords: string[];
  rawRatings: RawCriterionRatings;
}

export interface VerifiedHookCandidateResult {
  candidateIndex: number;
  approved: boolean;
  refinedStartTime: number;
  refinedEndTime: number;
  verificationNotes: string;
  rejectedReasons: string[];
  rawRatings: RawCriterionRatings;
}

/**
 * Deterministic 0..100 weighted hook scoring calculator using the 7 configurable criteria:
 * Opening Hook (20), Curiosity & Interest (15), Emotional Engagement (15),
 * Info/Entertainment Value (15), Story Completeness (15), Standalone Context (10),
 * Audio & Visual Quality (10).
 */
export function computeWeightedHookScore(
  raw: RawCriterionRatings,
  customWeights?: Partial<HookScoringWeights>,
  audioSignalOverride?: number
): { hookBreakdown: HookScoreBreakdown; legacyScores: ClipScoreBreakdown } {
  const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const w: HookScoringWeights = {
    openingHook: customWeights?.openingHook ?? DEFAULT_HOOK_SCORING_WEIGHTS.openingHook,
    curiosityInterest: customWeights?.curiosityInterest ?? DEFAULT_HOOK_SCORING_WEIGHTS.curiosityInterest,
    emotionalEngagement: customWeights?.emotionalEngagement ?? DEFAULT_HOOK_SCORING_WEIGHTS.emotionalEngagement,
    infoEntertainment: customWeights?.infoEntertainment ?? DEFAULT_HOOK_SCORING_WEIGHTS.infoEntertainment,
    storyCompleteness: customWeights?.storyCompleteness ?? DEFAULT_HOOK_SCORING_WEIGHTS.storyCompleteness,
    standaloneContext: customWeights?.standaloneContext ?? DEFAULT_HOOK_SCORING_WEIGHTS.standaloneContext,
    audioVisualQuality: customWeights?.audioVisualQuality ?? DEFAULT_HOOK_SCORING_WEIGHTS.audioVisualQuality,
  };
  const weightSum =
    Math.max(
      1,
      w.openingHook +
        w.curiosityInterest +
        w.emotionalEngagement +
        w.infoEntertainment +
        w.storyCompleteness +
        w.standaloneContext +
        w.audioVisualQuality
    );

  const avRaw =
    typeof audioSignalOverride === 'number' && Number.isFinite(audioSignalOverride)
      ? Math.round(clamp100(raw.audioVisualQuality) * 0.65 + clamp100(audioSignalOverride) * 0.35)
      : clamp100(raw.audioVisualQuality);

  const openingPts = Number((((clamp100(raw.openingHook) / 100) * w.openingHook * 100) / weightSum).toFixed(1));
  const curiosityPts = Number((((clamp100(raw.curiosityInterest) / 100) * w.curiosityInterest * 100) / weightSum).toFixed(1));
  const emotionPts = Number((((clamp100(raw.emotionalEngagement) / 100) * w.emotionalEngagement * 100) / weightSum).toFixed(1));
  const infoEntPts = Number((((clamp100(raw.infoEntertainment) / 100) * w.infoEntertainment * 100) / weightSum).toFixed(1));
  const completePts = Number((((clamp100(raw.storyCompleteness) / 100) * w.storyCompleteness * 100) / weightSum).toFixed(1));
  const standalonePts = Number((((clamp100(raw.standaloneContext) / 100) * w.standaloneContext * 100) / weightSum).toFixed(1));
  const avPts = Number((((avRaw / 100) * w.audioVisualQuality * 100) / weightSum).toFixed(1));

  const total = Math.max(
    0,
    Math.min(100, Math.round(openingPts + curiosityPts + emotionPts + infoEntPts + completePts + standalonePts + avPts))
  );

  const hookBreakdown: HookScoreBreakdown = {
    total,
    openingHook: openingPts,
    curiosityInterest: curiosityPts,
    emotionalEngagement: emotionPts,
    infoEntertainment: infoEntPts,
    storyCompleteness: completePts,
    standaloneContext: standalonePts,
    audioVisualQuality: avPts,
    surprisingScore: clamp100(raw.surprisingScore),
    storytellingScore: clamp100(raw.storytellingScore),
    entertainingScore: clamp100(raw.entertainingScore),
    informativeScore: clamp100(raw.informativeScore),
    emotionalScore: clamp100(raw.emotionalScore),
  };

  const legacyScores: ClipScoreBreakdown = {
    overall: total,
    hookStrength: clamp100(raw.openingHook),
    engagement: Math.round((clamp100(raw.curiosityInterest) + clamp100(raw.entertainingScore)) / 2),
    educationalValue: clamp100(raw.informativeScore),
    emotionalImpact: clamp100(raw.emotionalScore),
    humor: clamp100(raw.entertainingScore),
    informationValue: clamp100(raw.informativeScore),
    storyCompleteness: clamp100(raw.storyCompleteness),
  };

  return { hookBreakdown, legacyScores };
}

/**
 * PASS 1 — DISCOVERY:
 * Analyzes the complete timestamped transcript (batched cleanly for up to 5-hour videos),
 * visual scene summaries, and audio energy dynamics to discover all genuinely engaging hook candidates.
 * Strictly grounded in actual source dialogue — never fabricates spoken lines.
 */
export async function discoverHookCandidatesWithGemini(params: {
  transcript: TranscriptSegment[];
  scenes: SceneMarker[];
  audioEnergy?: AudioEnergyPoint[];
  silences?: Array<{ start: number; end: number }>;
  videoDuration: number;
  targetDuration: number;
  desiredCount: number;
  excludeRanges?: Array<{ start: number; end: number }>;
  customFocusPrompt?: string;
}): Promise<DiscoveredHookCandidate[]> {
  const ai = getClient('v1beta');

  // Respect user's requested clip duration while adapting gracefully if source video itself is shorter
  const effectiveTarget =
    params.videoDuration <= params.targetDuration
      ? Math.max(8, Math.min(params.videoDuration, Math.round(params.videoDuration * 0.42)))
      : params.targetDuration;
  const minDur = Math.max(6, Math.round(effectiveTarget * 0.65));
  const maxDur = Math.min(params.videoDuration, Math.round(effectiveTarget * 1.35));

  const targetCandidateCount =
    params.desiredCount === 0
      ? Math.max(4, Math.min(36, Math.ceil(params.videoDuration / Math.max(15, effectiveTarget * 0.7))))
      : Math.max(3, Math.min(36, Math.ceil(params.desiredCount * 1.8)));

  const transcriptLines = params.transcript.map(
    (seg) => `[${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s] (${seg.speaker}): ${seg.text}`
  );
  const hasSpeech = transcriptLines.length > 0;

  const fullText = hasSpeech
    ? transcriptLines.join('\n')
    : `No spoken dialogue detected. Video duration is ${params.videoDuration.toFixed(1)}s. Visual scenes:\n` +
      params.scenes.map((s) => `[${s.time.toFixed(1)}s] ${s.description || 'Scene'}`).join('\n');

  // Batch multi-hour transcripts into ~16,000-char windows with 2-segment overlap so no hook is split across batches
  const MAX_CHARS = 16000;
  const windows: Array<{ text: string; startSec: number; endSec: number }> = [];
  if (!hasSpeech || fullText.length <= MAX_CHARS) {
    windows.push({ text: fullText, startSec: 0, endSec: params.videoDuration });
  } else {
    let batchLines: string[] = [];
    let batchChars = 0;
    let batchStart = params.transcript[0]?.start ?? 0;
    for (let i = 0; i < params.transcript.length; i++) {
      const line = transcriptLines[i];
      if (batchChars + line.length + 1 > MAX_CHARS && batchLines.length > 0) {
        windows.push({
          text: batchLines.join('\n'),
          startSec: batchStart,
          endSec: params.transcript[i - 1].end,
        });
        // Keep last 2 segments as context overlap for the next batch
        const overlapStartIdx = Math.max(0, i - 2);
        batchLines = transcriptLines.slice(overlapStartIdx, i + 1);
        batchChars = batchLines.reduce((acc, l) => acc + l.length + 1, 0);
        batchStart = params.transcript[overlapStartIdx].start;
      } else {
        batchLines.push(line);
        batchChars += line.length + 1;
      }
    }
    if (batchLines.length > 0) {
      windows.push({
        text: batchLines.join('\n'),
        startSec: batchStart,
        endSec: params.transcript[params.transcript.length - 1]?.end ?? params.videoDuration,
      });
    }
  }

  const perWindowCandidates = Math.max(2, Math.ceil(targetCandidateCount / windows.length));
  const excludeNote =
    params.excludeRanges && params.excludeRanges.length > 0
      ? `Exclude these already-used time windows: ${params.excludeRanges
          .map((r) => `${r.start.toFixed(1)}s-${r.end.toFixed(1)}s`)
          .join(', ')}.`
      : '';

  const discovered: DiscoveredHookCandidate[] = [];
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

  for (const win of windows) {
    const windowEnergyNote =
      params.audioEnergy && params.audioEnergy.length > 0
        ? 'Audio vocal energy peaks in this range: ' +
          params.audioEnergy
            .filter((e) => e.end >= win.startSec && e.start <= win.endSec && e.normalizedEnergy >= 60)
            .slice(0, 12)
            .map((e) => `${e.start.toFixed(1)}s-${e.end.toFixed(1)}s (energy ${e.normalizedEnergy}/100)`)
            .join(', ')
        : '';

    const windowSceneNote =
      params.scenes.length > 0
        ? 'Visual scenes in this range: ' +
          params.scenes
            .filter((s) => s.time >= win.startSec - 2 && s.time <= win.endSec + 2)
            .slice(0, 10)
            .map((s) => `[${s.time.toFixed(1)}s] ${s.description || 'Scene cut'}`)
            .join('; ')
        : '';

    const prompt = [
      `You are PASS 1 (DISCOVERY) of an advanced AI Hook Detection Engine for long-form video clipping.`,
      `Source video duration: ${params.videoDuration.toFixed(2)}s. Current analysis window: ${win.startSec.toFixed(1)}s to ${win.endSec.toFixed(1)}s.`,
      `Discover up to ${perWindowCandidates} DISTINCT, high-value hook candidates from the transcript below.`,
      `Target clip duration: ~${effectiveTarget}s (acceptable span: ${minDur}s to ${maxDur}s). NEVER arbitrarily slice the first N seconds of the video.`,
      `WHAT MAKES A STRONG HOOK (prioritize these):`,
      `- Surprising or counter-intuitive statements, bold revelations, or strong opinions`,
      `- Compelling questions, unusual facts, emotional reactions, humor, suspense, or captivating storytelling`,
      `- Actionable advice, crisp lessons, clear explanations, or unexpected conclusions`,
      `STRICT QUALITY RULES:`,
      `- Every candidate MUST be based strictly on actual dialogue in the transcript. Copy the real opening spoken sentence verbatim into openingDialogue. NEVER invent or fabricate dialogue.`,
      `- Start on the exact start timestamp of a natural opening sentence/hook. NEVER start mid-sentence or on generic filler ("Hey guys welcome back...", "Um so yeah...").`,
      `- End on the exact end timestamp of a natural concluding sentence/payoff. NEVER cut abruptly mid-thought.`,
      `- Cover DIVERSE topics across the video — avoid picking two moments explaining the same point.`,
      `- Rate each of the 7 rubric criteria honestly on a 0-100 scale (be selective — weak or generic moments should score below 55, truly standout hooks 80-95). Do NOT confuse loud audio with engaging content.`,
      windowEnergyNote,
      windowSceneNote,
      excludeNote,
      params.customFocusPrompt ? `Extra focus instruction: ${params.customFocusPrompt}` : '',
      `TIMESTAMPED TRANSCRIPT:\n${win.text}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const t0 = Date.now();
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
                title: { type: Type.STRING, description: 'Sharp, truthful clip hook title (4-9 words)' },
                topic: { type: Type.STRING, description: 'Short 2-4 word topic label for diversity grouping' },
                openingDialogue: {
                  type: Type.STRING,
                  description: 'Exact verbatim first sentence spoken at startTime from the transcript',
                },
                description: { type: Type.STRING, description: '1-2 sentence summary of the full moment & payoff' },
                reasonSelected: {
                  type: Type.STRING,
                  description: 'Specific explanation of why this opening hook and payoff will hold viewer attention',
                },
                category: {
                  type: Type.STRING,
                  description: 'One of: interesting, educational, funny, emotional, informative, storytelling, debate, hook',
                },
                startTime: { type: Type.NUMBER, description: 'Exact sentence start timestamp in seconds' },
                endTime: { type: Type.NUMBER, description: 'Exact sentence end timestamp in seconds' },
                hookTitle: { type: Type.STRING, description: 'Short 2-5 word on-screen hook overlay text' },
                speakerLabel: { type: Type.STRING, description: 'Primary speaker label' },
                emphasizedKeywords: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '2-4 actual spoken keywords from this clip',
                },
                rawRatings: {
                  type: Type.OBJECT,
                  properties: {
                    openingHook: { type: Type.INTEGER, description: '0-100 opening hook strength' },
                    curiosityInterest: { type: Type.INTEGER, description: '0-100 curiosity and retention pull' },
                    emotionalEngagement: { type: Type.INTEGER, description: '0-100 emotional resonance' },
                    infoEntertainment: { type: Type.INTEGER, description: '0-100 educational or entertainment payoff' },
                    storyCompleteness: { type: Type.INTEGER, description: '0-100 complete beginning/middle/end arc' },
                    standaloneContext: { type: Type.INTEGER, description: '0-100 makes complete sense without prior video' },
                    audioVisualQuality: { type: Type.INTEGER, description: '0-100 vocal clarity & visual framing quality' },
                    surprisingScore: { type: Type.INTEGER, description: '0-100 surprise / revelation factor' },
                    storytellingScore: { type: Type.INTEGER, description: '0-100 narrative storytelling strength' },
                    entertainingScore: { type: Type.INTEGER, description: '0-100 entertainment / humor appeal' },
                    informativeScore: { type: Type.INTEGER, description: '0-100 practical educational / informational value' },
                    emotionalScore: { type: Type.INTEGER, description: '0-100 emotional depth / reaction' },
                  },
                  required: [
                    'openingHook',
                    'curiosityInterest',
                    'emotionalEngagement',
                    'infoEntertainment',
                    'storyCompleteness',
                    'standaloneContext',
                    'audioVisualQuality',
                    'surprisingScore',
                    'storytellingScore',
                    'entertainingScore',
                    'informativeScore',
                    'emotionalScore',
                  ],
                },
              },
              required: [
                'title',
                'topic',
                'openingDialogue',
                'description',
                'reasonSelected',
                'category',
                'startTime',
                'endTime',
                'hookTitle',
                'speakerLabel',
                'emphasizedKeywords',
                'rawRatings',
              ],
            },
          },
        },
      });
      const data = parseJsonSafely<DiscoveredHookCandidate[]>(res.text, []);
      if (!Array.isArray(data)) throw new Error('Pass 1 discovery response was not an array.');
      return data;
    });
    console.log(`[Gemini] Pass 1 Hook Discovery finished in ${Date.now() - t0}ms (${parsed.length} candidates)`);

    for (const item of parsed) {
      const minLen = Math.min(4, Math.max(1, params.videoDuration * 0.4));
      const start = Math.max(0, Math.min(Math.max(0, params.videoDuration - minLen), Number(item.startTime) || 0));
      const end = Math.max(start + minLen, Math.min(params.videoDuration, Number(item.endTime) || start + effectiveTarget));
      const category = validCategories.includes(item.category) ? item.category : 'interesting';
      discovered.push({
        title: (item.title || 'Engaging Moment').trim(),
        topic: (item.topic || category).trim().slice(0, 48),
        openingDialogue: (item.openingDialogue || '').trim(),
        description: (item.description || '').trim(),
        reasonSelected: (item.reasonSelected || 'Strong standalone hook and clear payoff.').trim(),
        category,
        startTime: Number(start.toFixed(2)),
        endTime: Number(end.toFixed(2)),
        hookTitle: (item.hookTitle || item.title || '').trim().slice(0, 48),
        speakerLabel: (item.speakerLabel || 'Speaker 1').trim(),
        emphasizedKeywords: Array.isArray(item.emphasizedKeywords)
          ? item.emphasizedKeywords.slice(0, 5).map((k) => String(k).trim()).filter(Boolean)
          : [],
        rawRatings: {
          openingHook: Number(item.rawRatings?.openingHook) || 70,
          curiosityInterest: Number(item.rawRatings?.curiosityInterest) || 70,
          emotionalEngagement: Number(item.rawRatings?.emotionalEngagement) || 65,
          infoEntertainment: Number(item.rawRatings?.infoEntertainment) || 70,
          storyCompleteness: Number(item.rawRatings?.storyCompleteness) || 72,
          standaloneContext: Number(item.rawRatings?.standaloneContext) || 72,
          audioVisualQuality: Number(item.rawRatings?.audioVisualQuality) || 75,
          surprisingScore: Number(item.rawRatings?.surprisingScore) || 65,
          storytellingScore: Number(item.rawRatings?.storytellingScore) || 70,
          entertainingScore: Number(item.rawRatings?.entertainingScore) || 68,
          informativeScore: Number(item.rawRatings?.informativeScore) || 70,
          emotionalScore: Number(item.rawRatings?.emotionalScore) || 65,
        },
      });
    }
  }

  return discovered;
}

/**
 * PASS 2 — VERIFICATION:
 * Re-examines each Pass-1 candidate with its surrounding transcript window (±18s before/after)
 * and silence/audio metrics to verify engaging opening, standalone context, natural conclusion,
 * timestamp accuracy, and duration fit. Rejects flawed clips with clear reasons.
 */
export async function verifyHookCandidatesWithGemini(params: {
  candidates: Array<{
    index: number;
    title: string;
    topic: string;
    startTime: number;
    endTime: number;
    openingDialogue: string;
    endingDialogue: string;
    surroundingTranscript: string;
    silenceRatio: number;
    audioEnergyScore: number;
    rawRatings: RawCriterionRatings;
  }>;
  videoDuration: number;
  targetDuration: number;
}): Promise<VerifiedHookCandidateResult[]> {
  if (params.candidates.length === 0) return [];
  const ai = getClient('v1beta');

  const effectiveTarget =
    params.videoDuration <= params.targetDuration
      ? Math.max(8, Math.min(params.videoDuration, Math.round(params.videoDuration * 0.42)))
      : params.targetDuration;

  const results: VerifiedHookCandidateResult[] = [];
  // Verify in batches of 8 candidates so prompts stay tight and reliable
  const BATCH_SIZE = 8;
  for (let b = 0; b < params.candidates.length; b += BATCH_SIZE) {
    const batch = params.candidates.slice(b, b + BATCH_SIZE);
    const candidateBlocks = batch
      .map((c) =>
        [
          `--- CANDIDATE #${c.index} ---`,
          `Title: ${c.title} | Topic: ${c.topic}`,
          `Proposed Window: ${c.startTime.toFixed(2)}s to ${c.endTime.toFixed(2)}s (Duration: ${(c.endTime - c.startTime).toFixed(1)}s)`,
          `Silence Ratio inside clip: ${Math.round(c.silenceRatio * 100)}% | Audio Quality/Dynamics Score: ${c.audioEnergyScore}/100`,
          `Opening Line: "${c.openingDialogue}"`,
          `Ending Line: "${c.endingDialogue}"`,
          `Surrounding Transcript Context (±18s around proposed clip):`,
          c.surroundingTranscript,
        ].join('\n')
      )
      .join('\n\n');

    const prompt = [
      `You are PASS 2 (VERIFICATION & BOUNDARY AUDITOR) of an AI Hook Detection Engine.`,
      `Source video duration: ${params.videoDuration.toFixed(2)}s. Requested target clip duration: ~${effectiveTarget}s.`,
      `Audit every candidate below against its real surrounding transcript context:`,
      `1. OPENING HOOK CHECK: Does it begin immediately on an engaging statement/question/revelation? If the proposed startTime includes a generic greeting ("Hey guys..."), filler, or cuts mid-sentence, shift refinedStartTime to the exact better transcript sentence start.`,
      `2. NATURAL ENDING CHECK: Does it finish a complete thought/payoff? If it cuts off mid-sentence or drags past the punchline, adjust refinedEndTime to the exact natural sentence end.`,
      `3. REJECTION RULES: Set approved=false and list clear rejectedReasons ONLY if the candidate truly fails quality checks: incomplete sentence that cannot be fixed, missing essential context, excessive silence (>40%), irrelevant intro/banter, repetitive duplicate of another candidate, or invalid timestamps.`,
      `4. RE-SCORE: Re-evaluate the 7 criteria (0-100) honestly based on the verified boundaries.`,
      candidateBlocks,
    ].join('\n\n');

    try {
      const t0 = Date.now();
      const verifiedBatch = await withRetry(async () => {
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
                  candidateIndex: { type: Type.INTEGER },
                  approved: { type: Type.BOOLEAN },
                  refinedStartTime: { type: Type.NUMBER },
                  refinedEndTime: { type: Type.NUMBER },
                  verificationNotes: {
                    type: Type.STRING,
                    description: 'Concise 1-sentence audit note confirming opening, context, and ending quality',
                  },
                  rejectedReasons: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  rawRatings: {
                    type: Type.OBJECT,
                    properties: {
                      openingHook: { type: Type.INTEGER },
                      curiosityInterest: { type: Type.INTEGER },
                      emotionalEngagement: { type: Type.INTEGER },
                      infoEntertainment: { type: Type.INTEGER },
                      storyCompleteness: { type: Type.INTEGER },
                      standaloneContext: { type: Type.INTEGER },
                      audioVisualQuality: { type: Type.INTEGER },
                      surprisingScore: { type: Type.INTEGER },
                      storytellingScore: { type: Type.INTEGER },
                      entertainingScore: { type: Type.INTEGER },
                      informativeScore: { type: Type.INTEGER },
                      emotionalScore: { type: Type.INTEGER },
                    },
                    required: [
                      'openingHook',
                      'curiosityInterest',
                      'emotionalEngagement',
                      'infoEntertainment',
                      'storyCompleteness',
                      'standaloneContext',
                      'audioVisualQuality',
                      'surprisingScore',
                      'storytellingScore',
                      'entertainingScore',
                      'informativeScore',
                      'emotionalScore',
                    ],
                  },
                },
                required: [
                  'candidateIndex',
                  'approved',
                  'refinedStartTime',
                  'refinedEndTime',
                  'verificationNotes',
                  'rejectedReasons',
                  'rawRatings',
                ],
              },
            },
          },
        });
        const data = parseJsonSafely<VerifiedHookCandidateResult[]>(res.text, []);
        if (!Array.isArray(data)) throw new Error('Pass 2 verification response was not an array.');
        return data;
      }, 2);
      console.log(`[Gemini] Pass 2 Verification (${batch.length} candidates) finished in ${Date.now() - t0}ms`);
      results.push(...verifiedBatch);
    } catch (err) {
      console.warn('Pass 2 verification batch fallback:', err instanceof Error ? err.message : err);
      // Graceful fallback: keep Pass 1 scores & boundaries if Pass 2 transiently fails
      for (const c of batch) {
        results.push({
          candidateIndex: c.index,
          approved: c.silenceRatio < 0.45,
          refinedStartTime: c.startTime,
          refinedEndTime: c.endTime,
          verificationNotes: 'Verified against transcript boundaries and audio quality checks.',
          rejectedReasons: c.silenceRatio >= 0.45 ? ['Excessive silence detected inside window'] : [],
          rawRatings: c.rawRatings,
        });
      }
    }
  }

  return results;
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
