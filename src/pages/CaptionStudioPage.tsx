import React, { useEffect, useMemo, useState } from 'react';
import {
  Save,
  Layers,
  CheckCircle2,
  Loader2,
  UploadCloud,
  Download,
  FileText,
  Sparkles,
  ShieldCheck,
  Film,
  AlertCircle,
  Edit3,
  Waves,
  AudioWaveform,
  Type as TypeIcon,
  Layout,
  Play,
  RotateCcw,
} from 'lucide-react';
import type {
  CaptionAlignment,
  CaptionAnimation,
  CaptionPosition,
  CaptionStyleConfig,
  ClipRecord,
  ExportJob,
  ExportOptions,
  NavPage,
  ProjectRecord,
  TranscriptSegment,
} from '../../shared/types.ts';
import { CAPTION_FONTS, CAPTION_PRESETS, SUPPORTED_LANGUAGES } from '../../shared/presets.ts';
import { ClipPreviewPlayer } from '../components/ClipPreviewPlayer.tsx';
import { api } from '../lib/api.ts';
import { formatBytes, formatTimecode, isRtlText } from '../lib/format.ts';

interface CaptionStudioPageProps {
  project: ProjectRecord | null;
  clipId: string | null;
  exportJobs: ExportJob[];
  onSelectClip: (clipId: string) => void;
  onSaveClip: (projectId: string, clip: ClipRecord) => Promise<ClipRecord>;
  onApplyToAll: (
    projectId: string,
    clipId: string,
    style: CaptionStyleConfig
  ) => Promise<void>;
  onCreateFullVideoCaptions: (
    projectId: string,
    payload?: { captionPresetId?: string; autoRender?: boolean }
  ) => Promise<void>;
  onResyncAudioCaptions?: (projectId: string, clipId?: string) => Promise<number>;
  onAnalyzeClipAudioCaptions?: (
    projectId: string,
    clipId: string
  ) => Promise<{ alignedSegments: number; wordCount: number }>;
  onExportClip: (
    projectId: string,
    clipId: string,
    options?: Partial<ExportOptions>
  ) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

type SettingsTab = 'all' | 'presets' | 'animation' | 'typography' | 'layout' | 'sync' | 'words';

const ANIMATION_OPTIONS: Array<{
  id: CaptionAnimation;
  label: string;
  badge: string;
  desc: string;
}> = [
  { id: 'wave', label: 'Waving Flow', badge: 'WAVE', desc: 'Smooth continuous sinusoidal wave motion across words' },
  { id: 'bounce', label: 'Elastic Bounce', badge: 'BOUNCE', desc: 'Active spoken word bounces upward on vocal beat' },
  { id: 'pop', label: 'Pop Spring', badge: 'POP', desc: 'Punchy creator spring scale on active word' },
  { id: 'karaoke', label: 'Karaoke Sweep', badge: 'KARAOKE', desc: 'Progressive word-by-word illumination along line' },
  { id: 'typewriter', label: 'Typewriter Reveal', badge: 'TYPE', desc: 'Words appear live one-by-one as voiceover speaks' },
  { id: 'shake', label: 'Hype Shake', badge: 'SHAKE', desc: 'High-energy micro-shake emphasis on spoken word' },
  { id: 'neon_pulse', label: 'Neon Pulse Halo', badge: 'NEON', desc: 'Radiant multi-layer pulsing aura around active word' },
  { id: 'flip', label: '3D Flip In', badge: '3D FLIP', desc: 'Perspective 3D tilt-in reveal on each spoken word' },
  { id: 'glow', label: 'Radiant Glow', badge: 'GLOW', desc: 'Luminous studio halo highlight on spoken word' },
  { id: 'slide', label: 'Slide Up', badge: 'SLIDE', desc: 'Clean editorial upward entrance transition' },
  { id: 'fade', label: 'Smooth Fade', badge: 'FADE', desc: 'Cinema broadcast cross-fade transition' },
  { id: 'none', label: 'Static Clean', badge: 'STATIC', desc: 'Zero motion distraction with instant word highlight' },
];

function rebuildWordTimings(seg: TranscriptSegment, nextText: string): TranscriptSegment {
  const cleaned = nextText.replace(/\s+/g, ' ').trim();
  const tokens = cleaned ? cleaned.split(' ') : [];
  const totalDur = Math.max(0.2, seg.end - seg.start);
  if (tokens.length === 0) {
    return { ...seg, text: '', words: [] };
  }

  // Weight by syllables + punctuation pauses so edited words stay locked to voiceover cadence
  const metrics = tokens.map((t, idx) => {
    const cleanAlpha = t.replace(/[^a-zA-Z0-9\u0600-\u06FF\u0900-\u097F]/g, '');
    const vowels = cleanAlpha.match(/[aeiouyAEIOUY]+/g);
    const syl = vowels ? Math.max(1, vowels.length) : Math.max(1, Math.ceil(cleanAlpha.length / 3));
    const speakW = Math.max(1.25, syl * 1.15 + cleanAlpha.length * 0.22);
    let pauseW = 0;
    if (idx < tokens.length - 1) {
      if (/[.!?؟۔]+["')\]}]*$/.test(t)) pauseW = 1.65;
      else if (/[,;:—–\-]+["')\]}]*$/.test(t)) pauseW = 1.05;
    }
    return { speakW, totalW: speakW + pauseW };
  });

  const sumW = metrics.reduce((a, b) => a + b.totalW, 0);
  let cursor = seg.start;

  return {
    ...seg,
    text: cleaned,
    words: tokens.map((word, idx) => {
      const m = metrics[idx];
      const slotDur = (m.totalW / sumW) * totalDur;
      const speakDur = idx === tokens.length - 1 ? slotDur : slotDur * (m.speakW / Math.max(0.1, m.totalW));
      const start = Number(cursor.toFixed(3));
      const end = Number(Math.min(seg.end, Math.max(start + 0.045, idx === tokens.length - 1 ? seg.end : cursor + speakDur)).toFixed(3));
      cursor += slotDur;
      return {
        id: `${seg.id}_w${idx}`,
        word,
        start,
        end,
      };
    }),
  };
}

export function CaptionStudioPage({
  project,
  clipId,
  exportJobs,
  onSelectClip,
  onSaveClip,
  onApplyToAll,
  onCreateFullVideoCaptions,
  onResyncAudioCaptions,
  onAnalyzeClipAudioCaptions,
  onExportClip,
  onNavigate,
}: CaptionStudioPageProps) {
  const sourceClip = useMemo(() => {
    if (!project || project.clips.length === 0) return null;
    return (
      project.clips.find((c) => c.id === clipId) ??
      project.clips.find((c) => c.isFullVideoCaption) ??
      project.clips[0]
    );
  }, [project, clipId]);

  const hasFullVideoTrack = useMemo(
    () => Boolean(project?.clips.some((c) => c.isFullVideoCaption)),
    [project?.clips]
  );

  const [style, setStyle] = useState<CaptionStyleConfig>(
    sourceClip ? { ...sourceClip.captionStyle } : { ...CAPTION_PRESETS[0].config }
  );
  const [editedSegments, setEditedSegments] = useState<TranscriptSegment[] | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('all');
  const [seekTime, setSeekTime] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const [creatingFull, setCreatingFull] = useState(false);
  const [resyncingAudio, setResyncingAudio] = useState(false);
  const [analyzingClipAudio, setAnalyzingClipAudio] = useState(false);
  const [renderingMp4, setRenderingMp4] = useState(false);
  const [downloadingMp4, setDownloadingMp4] = useState(false);
  const [downloadingSoftSub, setDownloadingSoftSub] = useState(false);
  const [downloadingChroma, setDownloadingChroma] = useState(false);
  const [chromaColor, setChromaColor] = useState<'#00FF00' | '#00B140' | '#0047AB' | '#000000'>('#00FF00');
  const [chromaIncludeAudio, setChromaIncludeAudio] = useState(true);
  const [chromaPreviewEnabled, setChromaPreviewEnabled] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (sourceClip) {
      setStyle({ ...sourceClip.captionStyle });
      setEditedSegments(sourceClip.customSegments ?? null);
    }
  }, [sourceClip?.id]);

  const baseSegments = useMemo(() => {
    if (!project || !sourceClip) return [];
    if (editedSegments && editedSegments.length > 0) return editedSegments;
    if (sourceClip.customSegments && sourceClip.customSegments.length > 0) {
      return sourceClip.customSegments;
    }
    return project.transcript.filter(
      (s) => s.end > sourceClip.startTime && s.start < sourceClip.endTime
    );
  }, [editedSegments, sourceClip, project]);

  const latestJob = useMemo(() => {
    if (!project || !sourceClip) return null;
    return exportJobs.find((j) => j.projectId === project.id && j.clipId === sourceClip.id) ?? null;
  }, [exportJobs, project, sourceClip]);

  if (!project) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">Caption Studio</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Upload a video to generate high-end synchronized captions on your full original video (zero video changes) or on individual clips.
        </p>
        <button
          onClick={() => onNavigate('upload')}
          className="mt-5 studio-btn-primary inline-flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-medium text-white"
        >
          <UploadCloud className="w-4 h-4" /> Upload Video
        </button>
      </div>
    );
  }

  if (!sourceClip) {
    return (
      <div className="p-10 rounded-2xl studio-panel max-w-2xl mx-auto text-center space-y-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-[#059669]/18 border border-[#10B981]/35 text-xs font-medium text-emerald-300">
          <ShieldCheck className="w-4 h-4 text-[#F5C451]" />
          Original Video Preserved · Zero Video Changes
        </div>
        <h2 className="font-display text-xl font-bold text-white">
          Generate High-End Captions for &ldquo;{project.name}&rdquo;
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Create studio-grade voiceover-synced captions across your entire original video without cutting, cropping, or altering colors, and download in the exact same original quality.
        </p>
        {errorMsg && (
          <div className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/12 border border-red-500/30 text-xs text-red-200">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {errorMsg}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <button
            disabled={creatingFull}
            onClick={async () => {
              setErrorMsg(null);
              setCreatingFull(true);
              try {
                await onCreateFullVideoCaptions(project.id, {
                  captionPresetId: style.presetId || 'loki-emerald-gold',
                  autoRender: true,
                });
              } catch (err) {
                setErrorMsg(err instanceof Error ? err.message : 'Failed to start full-video captioning.');
              } finally {
                setCreatingFull(false);
              }
            }}
            className="studio-btn-primary inline-flex items-center gap-2 h-11 px-6 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
          >
            {creatingFull ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 text-[#FEF3C7]" />
            )}
            {creatingFull ? 'Generating High-End Captions...' : 'Caption Full Original Video (Same Quality)'}
          </button>
          <button
            onClick={() => onNavigate('upload')}
            className="inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-zinc-200"
          >
            <UploadCloud className="w-4 h-4 text-[#F5C451]" /> Upload Different Video
          </button>
        </div>
      </div>
    );
  }

  const previewClip: ClipRecord = {
    ...sourceClip,
    captionStyle: style,
    customSegments: editedSegments ?? sourceClip.customSegments,
  };

  const isFullOriginal = Boolean(sourceClip.isFullVideoCaption || sourceClip.preserveOriginalVideo);
  const isLandscapePreview =
    isFullOriginal &&
    Boolean(project.metadata && project.metadata.width >= project.metadata.height);

  const isRenderingNow = Boolean(
    renderingMp4 ||
      (latestJob && (latestJob.status === 'queued' || latestJob.status === 'rendering')) ||
      sourceClip.renderStatus === 'queued' ||
      sourceClip.renderStatus === 'rendering' ||
      sourceClip.renderStatus === 'validating' ||
      sourceClip.renderStatus === 'saving'
  );

  const isMp4Ready = Boolean(
    !isRenderingNow && (sourceClip.renderStatus === 'export_ready' || sourceClip.renderedVideoUrl)
  );

  const handleSaveCurrent = async () => {
    setErrorMsg(null);
    setSaving(true);
    try {
      await onSaveClip(project.id, previewClip);
      setFeedback('High-end caption style, animation & sync settings saved.');
      setTimeout(() => setFeedback(null), 2400);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save caption style.');
    } finally {
      setSaving(false);
    }
  };

  const handleApplyAll = async () => {
    setErrorMsg(null);
    setApplyingAll(true);
    try {
      await onApplyToAll(project.id, sourceClip.id, style);
      setFeedback(`Applied style to all ${project.clips.length} items in this project.`);
      setTimeout(() => setFeedback(null), 2600);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to apply style.');
    } finally {
      setApplyingAll(false);
    }
  };

  const handleResyncWithVoiceover = async () => {
    setErrorMsg(null);
    setResyncingAudio(true);
    try {
      let count = 0;
      if (onResyncAudioCaptions) {
        count = await onResyncAudioCaptions(project.id, sourceClip.id);
      } else {
        const res = await api.resyncAudioCaptions(project.id, sourceClip.id);
        count = res.alignedSegments;
      }
      setEditedSegments(null);
      setFeedback(
        `Voiceover Audio Sync complete: snapped ${count} caption segments & word timestamps to exact speech waveform onsets.`
      );
      setTimeout(() => setFeedback(null), 3600);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Voiceover audio re-sync failed.');
    } finally {
      setResyncingAudio(false);
    }
  };

  const handleAnalyzeClipAudioAndGenerateCaptions = async () => {
    setErrorMsg(null);
    setAnalyzingClipAudio(true);
    try {
      let alignedSegments = 0;
      let wordCount = 0;
      if (onAnalyzeClipAudioCaptions) {
        const res = await onAnalyzeClipAudioCaptions(project.id, sourceClip.id);
        alignedSegments = res.alignedSegments;
        wordCount = res.wordCount;
      } else {
        const res = await api.analyzeClipAudioCaptions(project.id, sourceClip.id);
        alignedSegments = res.alignedSegments;
        wordCount = res.wordCount;
      }
      setEditedSegments(null);
      setFeedback(
        `High-End Clip Audio Analysis complete: generated ${alignedSegments} voiceover-locked caption lines (${wordCount} words).`
      );
      setTimeout(() => setFeedback(null), 3800);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Clip audio caption analysis failed.');
    } finally {
      setAnalyzingClipAudio(false);
    }
  };

  const handleDownloadChromaGreenCaptions = async () => {
    setErrorMsg(null);
    setDownloadingChroma(true);
    try {
      await onSaveClip(project.id, previewClip);
      await api.downloadClipChromaCaptionsMp4(project.id, sourceClip.id, sourceClip.title, {
        chromaColor,
        includeAudio: chromaIncludeAudio,
        resolution: isFullOriginal ? 'original' : '1080p',
      });
      setFeedback(
        `Downloaded Animated Chroma Screen Captions MP4 (${chromaColor}) — import into CapCut, Premiere Pro, After Effects, or DaVinci Resolve and apply Chroma Key!`
      );
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Chroma Green Screen MP4 export failed.');
    } finally {
      setDownloadingChroma(false);
    }
  };

  const handleSaveAndRenderSameQuality = async () => {
    setErrorMsg(null);
    setRenderingMp4(true);
    try {
      await onSaveClip(project.id, previewClip);
      await onExportClip(project.id, sourceClip.id, {
        resolution: isFullOriginal ? 'original' : '1080p',
        codec: 'h264',
        fps: isFullOriginal ? 'original' : 30,
        quality: isFullOriginal ? 'master' : 'excellent',
        embedCaptions: true,
        includeMusic: !isFullOriginal,
      });
      setFeedback(
        isFullOriginal
          ? 'Rendering full original video with voice-synced captions at original quality...'
          : 'Rendering clip with updated high-end captions...'
      );
      setTimeout(() => setFeedback(null), 3500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not start captioned MP4 render.');
    } finally {
      setRenderingMp4(false);
    }
  };

  const handleDownloadBurnedMp4 = async () => {
    setErrorMsg(null);
    setDownloadingMp4(true);
    try {
      await api.downloadClipMp4(project.id, sourceClip.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'MP4 download failed.');
    } finally {
      setDownloadingMp4(false);
    }
  };

  const handleDownloadSoftSubMp4 = async () => {
    setErrorMsg(null);
    setDownloadingSoftSub(true);
    try {
      await onSaveClip(project.id, previewClip);
      await api.downloadClipSoftSubMp4(project.id, sourceClip.id, sourceClip.title);
      setFeedback('Downloaded lossless bit-exact MP4 with embedded selectable captions (0% video re-encode).');
      setTimeout(() => setFeedback(null), 3200);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Lossless soft-sub MP4 download failed.');
    } finally {
      setDownloadingSoftSub(false);
    }
  };

  const handleCreateFullVideoTrack = async () => {
    setErrorMsg(null);
    setCreatingFull(true);
    try {
      await onCreateFullVideoCaptions(project.id, {
        captionPresetId: style.presetId || 'loki-emerald-gold',
        autoRender: false,
      });
      setFeedback('Full original video caption track created — zero video changes applied.');
      setTimeout(() => setFeedback(null), 2800);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not create full-video caption track.');
    } finally {
      setCreatingFull(false);
    }
  };

  const showSection = (sec: Exclude<SettingsTab, 'all'>) => activeTab === 'all' || activeTab === sec;

  return (
    <div className="space-y-4">
      {/* Compact Studio Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Caption Studio</h1>
          <p className="mt-0.5 text-xs text-zinc-400">
            60fps voiceover-locked captions · 12 animations (Waving Flow, Bounce, Karaoke, Typewriter, Neon Pulse) · Pinned video preview while scrolling settings.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void handleAnalyzeClipAudioAndGenerateCaptions()}
            disabled={analyzingClipAudio}
            title="Extract this clip's audio track, run high-end AI speech analysis & generate frame-locked captions"
            className="studio-btn-primary inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-semibold text-white whitespace-nowrap"
          >
            {analyzingClipAudio ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#FEF3C7]" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-[#FEF3C7]" />
            )}
            {analyzingClipAudio ? 'Analyzing Clip Audio...' : 'Analyze Clip Audio & Generate Captions'}
          </button>

          <button
            onClick={() => void handleResyncWithVoiceover()}
            disabled={resyncingAudio}
            title="Analyze audio waveform pauses & snap caption words to exact voiceover onsets"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#059669]/22 hover:bg-[#059669]/35 border border-[#10B981]/45 text-xs font-semibold text-emerald-200 whitespace-nowrap transition-colors"
          >
            {resyncingAudio ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#F5C451]" />
            ) : (
              <AudioWaveform className="w-3.5 h-3.5 text-[#F5C451]" />
            )}
            {resyncingAudio ? 'Syncing Voiceover...' : 'Auto-Sync Voiceover'}
          </button>

          {!hasFullVideoTrack && (
            <button
              onClick={() => void handleCreateFullVideoTrack()}
              disabled={creatingFull}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#10B981]/35 text-xs font-semibold text-emerald-200 whitespace-nowrap"
            >
              {creatingFull ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Film className="w-3.5 h-3.5 text-[#F5C451]" />
              )}
              Caption Full Original Video
            </button>
          )}

          <select
            value={sourceClip.id}
            onChange={(e) => onSelectClip(e.target.value)}
            className="h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs text-white max-w-[230px] truncate"
          >
            {project.clips.map((c, idx) => (
              <option key={c.id} value={c.id} className="bg-[#0C1510]">
                {c.isFullVideoCaption ? `★ Full Original: ${project.name}` : `Clip ${idx + 1}: ${c.title}`}
              </option>
            ))}
          </select>

          <button
            onClick={() => void handleSaveCurrent()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/25 text-xs font-semibold text-white whitespace-nowrap"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5 text-[#F5C451]" />}
            Save
          </button>

          {project.clips.length > 1 && (
            <button
              onClick={() => void handleApplyAll()}
              disabled={applyingAll}
              className="studio-btn-primary inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-semibold text-white whitespace-nowrap"
            >
              {applyingAll ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Layers className="w-3.5 h-3.5 text-[#FEF3C7]" />
              )}
              Apply to All
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {feedback}
        </div>
      )}

      {errorMsg && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/12 border border-red-500/30 text-xs text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          {errorMsg}
        </div>
      )}

      {/* Split Studio Workspace:
          Left Column stays stationary/sticky in viewport so the video NEVER scrolls away.
          Right Column has its own independent scroll container (overscroll-contain) so scrolling settings leaves the video fixed in place! */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Stationary Pinned Video Preview + Same-Quality Export Dock */}
        <div className="lg:col-span-5 sticky top-16 lg:top-20 z-20 space-y-3.5 self-start">
          <div className="p-4 sm:p-5 rounded-xl studio-panel flex flex-col items-center shadow-2xl">
            <div className="w-full mb-2.5 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-[#071811] border border-[#10B981]/30 text-[11px]">
              <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
                <ShieldCheck className="w-3.5 h-3.5 text-[#F5C451]" />
                {isFullOriginal ? 'Original Video Unchanged · Pinned Preview' : 'Pinned Live Preview (60fps Audio Sync)'}
              </span>
              <span className="font-mono text-zinc-300 tabular-nums">
                {project.metadata
                  ? `${project.metadata.width}×${project.metadata.height} · ${project.metadata.fps} FPS`
                  : 'Live Canvas'}
              </span>
            </div>

            <div className={isLandscapePreview ? 'w-full' : 'w-full max-w-[300px]'}>
              <ClipPreviewPlayer
                project={project}
                clip={previewClip}
                currentTime={seekTime}
                maxHeightClass={isLandscapePreview ? 'max-h-[340px]' : 'max-h-[430px]'}
                chromaPreviewColor={chromaPreviewEnabled ? chromaColor : null}
              />
            </div>

            <div className="mt-3 w-full pt-2.5 border-t border-[#D4AF37]/12 flex items-center justify-between text-[11px] text-zinc-400">
              <span>
                Active Animation:{' '}
                <strong className="text-[#F5C451] uppercase">{style.animation.replace('_', ' ')}</strong>
              </span>
              <button
                type="button"
                onClick={() => setChromaPreviewEnabled((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition-colors ${
                  chromaPreviewEnabled
                    ? 'bg-[#00FF00]/20 text-[#4ADE80] border border-[#00FF00]/50'
                    : 'bg-[#0C1510] hover:bg-[#132219] text-zinc-300 border border-[#D4AF37]/20'
                }`}
              >
                <span
                  style={{ backgroundColor: chromaColor }}
                  className="w-2.5 h-2.5 rounded-full border border-white/40 inline-block"
                />
                {chromaPreviewEnabled ? 'Exit Green Screen Preview' : 'Preview on Green Screen'}
              </button>
            </div>
          </div>

          {/* Direct Same-Quality Download & Chroma Green Screen Captions Export Panel */}
          <div className="p-4 rounded-xl studio-panel space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-xs sm:text-sm font-semibold text-white">
                  Export &amp; Download Captioned Video
                </h2>
                <p className="text-[11px] text-zinc-400">
                  {isFullOriginal
                    ? 'Exact original resolution, FPS & audio — zero video alterations.'
                    : 'Burns your high-end animated captions into a verified MP4.'}
                </p>
              </div>
            </div>

            {isRenderingNow && (
              <div className="p-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/25 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5 text-[#F5C451] font-medium truncate">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    {latestJob?.stageDetail || sourceClip.renderStageDetail || 'Rendering same-quality MP4...'}
                  </span>
                  <span className="font-mono text-white tabular-nums">{latestJob?.progress ?? 12}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[#132219] overflow-hidden">
                  <div
                    style={{ width: `${Math.max(6, latestJob?.progress ?? 12)}%` }}
                    className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-200"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              {isMp4Ready && (
                <button
                  onClick={() => void handleDownloadBurnedMp4()}
                  disabled={downloadingMp4}
                  className="w-full studio-btn-gold h-9 px-3.5 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloadingMp4 ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  {downloadingMp4
                    ? 'Downloading Captioned MP4...'
                    : `Download Captioned MP4 (${sourceClip.renderedResolution || 'Original'}${sourceClip.renderedFileSize ? ` · ${formatBytes(sourceClip.renderedFileSize)}` : ''})`}
                </button>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  onClick={() => void handleSaveAndRenderSameQuality()}
                  disabled={isRenderingNow}
                  className="studio-btn-primary h-9 px-3 rounded-lg text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-45"
                >
                  {isRenderingNow ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 text-[#FEF3C7]" />
                  )}
                  {isRenderingNow
                    ? 'Rendering MP4...'
                    : isMp4Ready
                      ? 'Save & Re-Render MP4'
                      : 'Render Burned-In MP4'}
                </button>

                <button
                  onClick={() => void handleDownloadSoftSubMp4()}
                  disabled={downloadingSoftSub}
                  className="h-9 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#10B981]/30 text-xs font-medium text-emerald-200 inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {downloadingSoftSub ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
                  )}
                  {downloadingSoftSub ? 'Packaging...' : 'Lossless Soft-Sub MP4'}
                </button>
              </div>
            </div>

            {/* Chroma Green Screen Animated Captions Export Box (For Premiere Pro / CapCut / After Effects / DaVinci Resolve) */}
            <div className="p-3 rounded-xl bg-[#07150E] border border-[#22C55E]/40 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span
                    style={{ backgroundColor: chromaColor }}
                    className="w-3 h-3 rounded-sm border border-white/40 shrink-0"
                  />
                  <span className="font-display text-xs font-semibold text-white">
                    Chroma Green Screen Animated Captions (.MP4)
                  </span>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-[#22C55E]/20 text-[#4ADE80] font-mono text-[10px] font-bold">
                  CHROMA KEY
                </span>
              </div>

              <p className="text-[11px] text-zinc-300 leading-snug">
                Exports <strong className="text-white">only your animated captions</strong> (Waving, Bounce, Karaoke, Glow) on a Chroma Key background so you can remove the green screen in CapCut, Premiere Pro, After Effects, or DaVinci Resolve.
              </p>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <div className="flex items-center gap-1.5">
                  {(
                    [
                      ['#00FF00', 'Chroma Green'],
                      ['#00B140', 'Broadcast Green'],
                      ['#0047AB', 'Chroma Blue'],
                      ['#000000', 'Black Matte'],
                    ] as const
                  ).map(([hex, label]) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setChromaColor(hex)}
                      title={label}
                      className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10px] font-medium border transition-all ${
                        chromaColor === hex
                          ? 'bg-[#13281C] border-[#F5C451] text-white'
                          : 'bg-[#0B140F] border-white/10 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <span
                        style={{ backgroundColor: hex }}
                        className="w-2.5 h-2.5 rounded-full border border-white/30"
                      />
                      {label.split(' ')[1]}
                    </button>
                  ))}
                </div>

                <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={chromaIncludeAudio}
                    onChange={(e) => setChromaIncludeAudio(e.target.checked)}
                    className="accent-[#22C55E]"
                  />
                  Sync Audio
                </label>
              </div>

              <button
                type="button"
                onClick={() => void handleDownloadChromaGreenCaptions()}
                disabled={downloadingChroma}
                className="w-full h-9 px-3.5 rounded-lg bg-gradient-to-r from-[#15803D] via-[#16A34A] to-[#059669] hover:brightness-110 border border-[#4ADE80]/50 text-xs font-semibold text-white inline-flex items-center justify-center gap-2 shadow-md disabled:opacity-50 transition-all"
              >
                {downloadingChroma ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5 text-[#FEF3C7]" />
                )}
                {downloadingChroma
                  ? 'Rendering Animated Chroma Captions MP4...'
                  : `Download Chroma ${chromaColor === '#0047AB' ? 'Blue' : chromaColor === '#000000' ? 'Matte' : 'Green'} Screen Captions (.MP4)`}
              </button>
            </div>

            <div className="pt-2 border-t border-[#D4AF37]/12 flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400">Subtitle Files:</span>
              <div className="flex items-center gap-1.5">
                <a
                  href={`/api/projects/${project.id}/clips/${sourceClip.id}/subtitles.srt`}
                  download
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/18 text-[11px] text-zinc-200"
                >
                  <FileText className="w-3 h-3 text-[#F5C451]" />
                  SRT
                </a>
                <a
                  href={`/api/projects/${project.id}/clips/${sourceClip.id}/subtitles.vtt`}
                  download
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/18 text-[11px] text-zinc-200"
                >
                  VTT
                </a>
                <a
                  href={`/api/projects/${project.id}/clips/${sourceClip.id}/subtitles.ass`}
                  download
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/18 text-[11px] text-zinc-200"
                >
                  Styled ASS
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Independently Scrollable Caption Settings Panel (Scrolling here NEVER moves the video!) */}
        <div className="lg:col-span-7 lg:max-h-[calc(100vh-145px)] lg:overflow-y-auto lg:pr-2 overscroll-contain space-y-4 pb-8">
          {/* Sticky Section Filter Bar inside the Settings Panel */}
          <div className="sticky top-0 z-10 p-2 rounded-xl bg-[#07110C]/95 backdrop-blur-md border border-[#D4AF37]/25 flex flex-wrap items-center gap-1.5 shadow-lg">
            {(
              [
                ['all', 'All Settings'],
                ['sync', 'Voiceover Sync'],
                ['animation', 'Waving & Animations'],
                ['presets', `${CAPTION_PRESETS.length} Presets`],
                ['typography', 'Fonts & Colors'],
                ['layout', 'Pill Box & Position'],
                ['words', `Edit Words (${baseSegments.length})`],
              ] as const
            ).map(([tabKey, label]) => (
              <button
                key={tabKey}
                type="button"
                onClick={() => setActiveTab(tabKey)}
                className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === tabKey
                    ? 'bg-[#059669] text-white border border-[#F5C451]/50 shadow-sm'
                    : 'bg-[#0C1510] hover:bg-[#132219] text-zinc-300 border border-transparent'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* SECTION 1: Voiceover Audio Synchronization & Timing Lock */}
          {showSection('sync') && (
            <div className="p-5 rounded-xl studio-panel space-y-4 border border-[#10B981]/30">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AudioWaveform className="w-4 h-4 text-[#10B981]" />
                  <div>
                    <h2 className="font-display text-sm font-semibold text-white">
                      Voiceover Audio Sync &amp; Millisecond Alignment
                    </h2>
                    <p className="text-[11px] text-zinc-400">
                      Lock captions to the exact spoken syllables &amp; breath pauses of your voiceover.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleResyncWithVoiceover()}
                  disabled={resyncingAudio}
                  className="studio-btn-primary inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-xs font-semibold text-white"
                >
                  {resyncingAudio ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <AudioWaveform className="w-3.5 h-3.5 text-[#FEF3C7]" />
                  )}
                  {resyncingAudio ? 'Analyzing Audio Waveform...' : 'Auto-Snap to Voiceover Waveform'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                <div className="p-3.5 rounded-lg bg-[#0A130E] border border-[#D4AF37]/15 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 font-medium">Global Caption Sync Offset</span>
                    <span className="font-mono text-[#F5C451] tabular-nums font-semibold">
                      {style.timingOffsetMs > 0 ? `+${style.timingOffsetMs}` : style.timingOffsetMs} ms
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-2000}
                    max={2000}
                    step={10}
                    value={style.timingOffsetMs}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, timingOffsetMs: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-1 pt-0.5">
                    {[-250, -100, -25, 0, 25, 100, 250].map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        onClick={() =>
                          setStyle((s) => ({
                            ...s,
                            timingOffsetMs:
                              delta === 0
                                ? 0
                                : Math.max(-2000, Math.min(2000, (s.timingOffsetMs || 0) + delta)),
                          }))
                        }
                        className={`px-2 py-1 rounded text-[11px] font-mono transition-colors ${
                          delta === 0
                            ? 'bg-[#132219] text-[#F5C451] border border-[#D4AF37]/30'
                            : 'bg-[#0E1913] hover:bg-[#16271E] text-zinc-300 border border-white/5'
                        }`}
                      >
                        {delta === 0 ? 'Reset 0ms' : delta > 0 ? `+${delta}ms` : `${delta}ms`}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Use <strong className="text-zinc-200">negative (-)</strong> if captions appear late, or{' '}
                    <strong className="text-zinc-200">positive (+)</strong> if captions appear too early.
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-[#0A130E] border border-[#D4AF37]/15 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 font-medium">Vocal Onset Lead-In (Word Lock)</span>
                    <span className="font-mono text-emerald-300 tabular-nums font-semibold">
                      {(style.wordLeadInMs ?? 35) > 0
                        ? `+${style.wordLeadInMs ?? 35}`
                        : (style.wordLeadInMs ?? 35)}{' '}
                      ms
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-150}
                    max={150}
                    step={5}
                    value={style.wordLeadInMs ?? 35}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, wordLeadInMs: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                  <div className="flex items-center justify-between text-[11px] text-zinc-400 pt-1">
                    <span>0ms (Strict)</span>
                    <button
                      type="button"
                      onClick={() => setStyle((s) => ({ ...s, wordLeadInMs: 35 }))}
                      className="text-[#F5C451] hover:underline flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" /> Default +35ms Studio Lock
                    </button>
                    <span>+150ms (Snappy)</span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Triggers active word highlight slightly ahead of vocal plosives so human ears perceive zero lag.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 2: Waving & Studio Caption Animations */}
          {showSection('animation') && (
            <div className="p-5 rounded-xl studio-panel space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Waves className="w-4 h-4 text-[#F5C451]" />
                  <div>
                    <h2 className="font-display text-sm font-semibold text-white">
                      Caption Motion &amp; Waving Animations (12 Styles)
                    </h2>
                    <p className="text-[11px] text-zinc-400">
                      Click any animation to preview live on your video above — fully supported in MP4 burn-in.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {ANIMATION_OPTIONS.map((anim) => {
                  const isSelected = style.animation === anim.id;
                  return (
                    <button
                      key={anim.id}
                      type="button"
                      onClick={() => setStyle((s) => ({ ...s, animation: anim.id }))}
                      className={`p-3 rounded-lg border text-left transition-all ${
                        isSelected
                          ? 'bg-[#059669]/22 border-[#F5C451] shadow-[0_0_18px_-6px_rgba(16,185,129,0.5)]'
                          : 'bg-[#0C1510] border-[#D4AF37]/15 hover:border-[#D4AF37]/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="text-xs font-semibold text-white">{anim.label}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                            isSelected
                              ? 'bg-[#F5C451] text-[#050A07]'
                              : 'bg-[#132219] text-emerald-300'
                          }`}
                        >
                          {anim.badge}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 line-clamp-2 leading-snug">
                        {anim.desc}
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* Animation Dynamics Sliders (Wave Height, Speed, Active Word Scale, Glow Intensity) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-[#D4AF37]/12">
                <div>
                  <div className="flex justify-between text-xs text-zinc-300 mb-1">
                    <span>Wave / Bounce Amplitude (Motion Height)</span>
                    <span className="font-mono tabular-nums text-[#F5C451]">
                      {style.waveAmplitude ?? 7}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={18}
                    step={1}
                    value={style.waveAmplitude ?? 7}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, waveAmplitude: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-300 mb-1">
                    <span>Animation Speed (Wave &amp; Pop Tempo)</span>
                    <span className="font-mono tabular-nums text-[#F5C451]">
                      {(style.animationSpeed ?? 1.0).toFixed(2)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.0}
                    step={0.05}
                    value={style.animationSpeed ?? 1.0}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, animationSpeed: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-300 mb-1">
                    <span>Active Spoken Word Pop Scale</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {Math.round((style.activeWordScale ?? 1.1) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1.0}
                    max={1.35}
                    step={0.02}
                    value={style.activeWordScale ?? 1.1}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, activeWordScale: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-300 mb-1">
                    <span>Neon / Radiant Glow Halo Intensity</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {style.glowIntensity ?? 14}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={28}
                    step={1}
                    value={style.glowIntensity ?? 14}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, glowIntensity: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* SECTION 3: 18 High-End Studio Caption Presets */}
          {showSection('presets') && (
            <div className="p-5 rounded-xl studio-panel">
              <h2 className="font-display text-sm font-semibold text-white mb-3">
                {CAPTION_PRESETS.length} High-End Studio Caption Presets
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {CAPTION_PRESETS.map((preset) => {
                  const active = style.presetId === preset.id;
                  const c = preset.config;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setStyle({ ...preset.config })}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        active
                          ? 'bg-[#059669]/20 border-[#D4AF37]/70'
                          : 'bg-[#0C1510] border-[#D4AF37]/12 hover:border-[#D4AF37]/35'
                      }`}
                    >
                      <div
                        style={{
                          backgroundColor:
                            c.backgroundOpacity > 0.2 ? c.backgroundColor : '#09090D',
                        }}
                        className="h-11 rounded-md flex items-center justify-center px-2 mb-2 overflow-hidden"
                      >
                        <span
                          style={{
                            fontFamily: c.fontFamily,
                            fontWeight: c.fontWeight,
                            color: c.textColor,
                            textShadow: c.shadow ? '0 1px 4px rgba(0,0,0,0.9)' : 'none',
                          }}
                          className="text-xs tracking-tight truncate"
                        >
                          {c.uppercase ? 'MAKE IT ' : 'Make it '}
                          <span
                            style={{
                              color: c.highlightColor,
                              backgroundColor:
                                (c.activeWordBgOpacity ?? 0) > 0.2
                                  ? c.activeWordBgColor
                                  : undefined,
                              padding:
                                (c.activeWordBgOpacity ?? 0) > 0.2 ? '1px 5px' : undefined,
                              borderRadius:
                                (c.activeWordBgOpacity ?? 0) > 0.2 ? '4px' : undefined,
                              textShadow:
                                c.animation === 'glow' || c.animation === 'wave'
                                  ? `0 0 10px ${c.highlightColor}`
                                  : undefined,
                            }}
                          >
                            {c.uppercase ? 'POP' : 'pop'}
                          </span>
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-white truncate">{preset.name}</div>
                      <div className="text-[11px] text-zinc-400 line-clamp-1 mt-0.5">
                        {preset.description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 4: Typography, Colors, Letter/Word Spacing & Shadows */}
          {showSection('typography') && (
            <div className="p-5 rounded-xl studio-panel space-y-5">
              <div className="flex items-center gap-2">
                <TypeIcon className="w-4 h-4 text-[#F5C451]" />
                <h2 className="font-display text-sm font-semibold text-white">
                  Typography, Colors, Stroke &amp; Shadow Studio
                </h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Font Family</label>
                  <select
                    value={style.fontFamily}
                    onChange={(e) => setStyle((s) => ({ ...s, fontFamily: e.target.value }))}
                    className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                  >
                    {CAPTION_FONTS.map((f) => (
                      <option key={f} value={f} className="bg-[#0C1510]">
                        {f}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Font Weight</label>
                  <select
                    value={style.fontWeight}
                    onChange={(e) =>
                      setStyle((s) => ({
                        ...s,
                        fontWeight: Number(e.target.value) as CaptionStyleConfig['fontWeight'],
                      }))
                    }
                    className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                  >
                    <option value={500} className="bg-[#0C1510]">Medium (500)</option>
                    <option value={600} className="bg-[#0C1510]">SemiBold (600)</option>
                    <option value={700} className="bg-[#0C1510]">Bold (700)</option>
                    <option value={800} className="bg-[#0C1510]">ExtraBold (800)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Text Case Transform</label>
                  <select
                    value={style.textTransform || (style.uppercase ? 'uppercase' : 'none')}
                    onChange={(e) => {
                      const mode = e.target.value as NonNullable<CaptionStyleConfig['textTransform']>;
                      setStyle((s) => ({
                        ...s,
                        textTransform: mode,
                        uppercase: mode === 'uppercase',
                      }));
                    }}
                    className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                  >
                    <option value="none" className="bg-[#0C1510]">Natural Sentence Case</option>
                    <option value="uppercase" className="bg-[#0C1510]">ALL CAPS (UPPERCASE)</option>
                    <option value="capitalize" className="bg-[#0C1510]">Title Case Words</option>
                    <option value="lowercase" className="bg-[#0C1510]">all lowercase</option>
                  </select>
                </div>
              </div>

              {/* Color Pickers */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {(
                  [
                    ['textColor', 'Text Color'],
                    ['highlightColor', 'Active Word'],
                    ['backgroundColor', 'Backdrop Box'],
                    ['strokeColor', 'Outline Stroke'],
                    ['shadowColor', 'Shadow Color'],
                  ] as const
                ).map(([key, label]) => {
                  const val = style[key] || '#000000';
                  return (
                    <label key={key} className="block text-xs text-zinc-400">
                      {label}
                      <div className="mt-1 flex items-center gap-2 h-9 px-2 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18">
                        <input
                          type="color"
                          value={val}
                          onChange={(e) => setStyle((s) => ({ ...s, [key]: e.target.value }))}
                          className="w-6 h-6 rounded bg-transparent border-0 cursor-pointer"
                        />
                        <span className="font-mono text-[11px] text-zinc-200 uppercase truncate">
                          {val}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Typography & Stroke Sliders */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Font Size</span>
                    <span className="font-mono tabular-nums text-zinc-200">{style.fontSize}px</span>
                  </div>
                  <input
                    type="range"
                    min={18}
                    max={64}
                    value={style.fontSize}
                    onChange={(e) => setStyle((s) => ({ ...s, fontSize: Number(e.target.value) }))}
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Outline Stroke Width</span>
                    <span className="font-mono tabular-nums text-zinc-200">{style.strokeWidth}px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={6}
                    step={0.5}
                    value={style.strokeWidth}
                    onChange={(e) => setStyle((s) => ({ ...s, strokeWidth: Number(e.target.value) }))}
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Letter Spacing (Tracking)</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {style.letterSpacing ?? 0}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-1}
                    max={8}
                    step={0.5}
                    value={style.letterSpacing ?? 0}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, letterSpacing: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Word Spacing Gap</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {style.wordSpacing ?? 4}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={18}
                    step={1}
                    value={style.wordSpacing ?? 4}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, wordSpacing: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Line Spacing</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {style.lineSpacing.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={1.7}
                    step={0.05}
                    value={style.lineSpacing}
                    onChange={(e) => setStyle((s) => ({ ...s, lineSpacing: Number(e.target.value) }))}
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Drop Shadow Blur Depth</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {style.shadowBlur ?? 10}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={24}
                    step={1}
                    value={style.shadowBlur ?? 10}
                    onChange={(e) =>
                      setStyle((s) => ({
                        ...s,
                        shadowBlur: Number(e.target.value),
                        shadow: Number(e.target.value) > 0,
                      }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-6 pt-2 border-t border-[#D4AF37]/12 text-xs text-zinc-200">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={style.wordLevelHighlight}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, wordLevelHighlight: e.target.checked }))
                    }
                    className="accent-[#10B981]"
                  />
                  Word-Level Highlighting
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(style.italic)}
                    onChange={(e) => setStyle((s) => ({ ...s, italic: e.target.checked }))}
                    className="accent-[#10B981]"
                  />
                  Italic Style
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={style.shadow}
                    onChange={(e) => setStyle((s) => ({ ...s, shadow: e.target.checked }))}
                    className="accent-[#10B981]"
                  />
                  Drop Shadow
                </label>
              </div>
            </div>
          )}

          {/* SECTION 5: Active-Word Pill Box, Backdrop & Screen Position */}
          {showSection('layout') && (
            <div className="p-5 rounded-xl studio-panel space-y-5">
              <div className="flex items-center gap-2">
                <Layout className="w-4 h-4 text-[#F5C451]" />
                <h2 className="font-display text-sm font-semibold text-white">
                  Active-Word Pill Box, Backdrop &amp; Screen Placement
                </h2>
              </div>

              {/* Active Word Pill Highlight Box */}
              <div className="p-3.5 rounded-lg bg-[#0A130E] border border-[#D4AF37]/15 grid grid-cols-1 sm:grid-cols-3 gap-4 items-center">
                <div>
                  <span className="block text-xs font-semibold text-white">
                    Active Spoken Word Pill Box
                  </span>
                  <span className="text-[11px] text-zinc-400">
                    Draws a viral rounded pill behind the currently spoken word.
                  </span>
                </div>

                <label className="block text-xs text-zinc-400">
                  Pill Color
                  <div className="mt-1 flex items-center gap-2 h-9 px-2 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18">
                    <input
                      type="color"
                      value={style.activeWordBgColor || '#10B981'}
                      onChange={(e) =>
                        setStyle((s) => ({
                          ...s,
                          activeWordBgColor: e.target.value,
                          activeWordBgOpacity:
                            (s.activeWordBgOpacity ?? 0) < 0.1 ? 0.92 : s.activeWordBgOpacity,
                        }))
                      }
                      className="w-6 h-6 rounded bg-transparent border-0 cursor-pointer"
                    />
                    <span className="font-mono text-[11px] text-zinc-200 uppercase">
                      {style.activeWordBgColor || '#10B981'}
                    </span>
                  </div>
                </label>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Pill Opacity</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {Math.round((style.activeWordBgOpacity ?? 0) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={style.activeWordBgOpacity ?? 0}
                    onChange={(e) =>
                      setStyle((s) => ({
                        ...s,
                        activeWordBgOpacity: Number(e.target.value),
                        activeWordBgColor: s.activeWordBgColor || '#10B981',
                      }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>
              </div>

              {/* Backdrop Box & Line Layout Sliders */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Caption Backdrop Opacity</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {Math.round(style.backgroundOpacity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={style.backgroundOpacity}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, backgroundOpacity: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Backdrop Corner Radius &amp; Padding</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {style.backgroundRadius ?? 10}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={24}
                    step={1}
                    value={style.backgroundRadius ?? 10}
                    onChange={(e) =>
                      setStyle((s) => ({
                        ...s,
                        backgroundRadius: Number(e.target.value),
                        backgroundPadding: Math.max(6, Math.round(Number(e.target.value) * 0.8 + 4)),
                      }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Vertical Screen Position (Top → Bottom)</span>
                    <span className="font-mono tabular-nums text-[#F5C451]">
                      {style.verticalOffset}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={92}
                    step={1}
                    value={style.verticalOffset}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const pos: CaptionPosition = v < 35 ? 'top' : v < 65 ? 'middle' : 'bottom';
                      setStyle((s) => ({ ...s, verticalOffset: v, position: pos }));
                    }}
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Horizontal Screen Position (Left → Right)</span>
                    <span className="font-mono tabular-nums text-[#F5C451]">
                      {style.horizontalOffset ?? 50}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={85}
                    step={1}
                    value={style.horizontalOffset ?? 50}
                    onChange={(e) =>
                      setStyle((s) => ({ ...s, horizontalOffset: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Words Per Line</span>
                    <span className="font-mono tabular-nums text-zinc-200">{style.wordsPerLine}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={9}
                    value={style.wordsPerLine}
                    onChange={(e) => setStyle((s) => ({ ...s, wordsPerLine: Number(e.target.value) }))}
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Zone Preset</label>
                    <select
                      value={style.position}
                      onChange={(e) => {
                        const pos = e.target.value as CaptionPosition;
                        setStyle((s) => ({
                          ...s,
                          position: pos,
                          verticalOffset: pos === 'top' ? 18 : pos === 'middle' ? 50 : 82,
                        }));
                      }}
                      className="w-full h-9 px-2 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                    >
                      <option value="top" className="bg-[#0C1510]">Top</option>
                      <option value="middle" className="bg-[#0C1510]">Middle</option>
                      <option value="bottom" className="bg-[#0C1510]">Bottom</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Alignment</label>
                    <select
                      value={style.alignment}
                      onChange={(e) =>
                        setStyle((s) => ({ ...s, alignment: e.target.value as CaptionAlignment }))
                      }
                      className="w-full h-9 px-2 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                    >
                      <option value="left" className="bg-[#0C1510]">Left</option>
                      <option value="center" className="bg-[#0C1510]">Center</option>
                      <option value="right" className="bg-[#0C1510]">Right</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Max Lines</label>
                    <select
                      value={style.maxLines}
                      onChange={(e) =>
                        setStyle((s) => ({ ...s, maxLines: Number(e.target.value) as 1 | 2 | 3 }))
                      }
                      className="w-full h-9 px-2 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                    >
                      <option value={1} className="bg-[#0C1510]">1 Line</option>
                      <option value={2} className="bg-[#0C1510]">2 Lines</option>
                      <option value={3} className="bg-[#0C1510]">3 Lines</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 6: Interactive Caption Words & Per-Segment Timestamp Sync Editor */}
          {showSection('words') && (
            <div className="p-5 rounded-xl studio-panel space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Edit3 className="w-4 h-4 text-[#F5C451]" />
                  <div>
                    <h2 className="font-display text-sm font-semibold text-white">
                      Edit Caption Words &amp; Segment Timestamps ({baseSegments.length} segments)
                    </h2>
                    <p className="text-[11px] text-zinc-400">
                      Click any timestamp to jump the video preview directly to that spoken line.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1 overscroll-contain">
                {baseSegments.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-4 text-center">
                    No transcript segments found for this video yet.
                  </p>
                ) : (
                  baseSegments.map((seg, idx) => {
                    const relSegStart = Math.max(0, seg.start - sourceClip.startTime);
                    return (
                      <div
                        key={seg.id}
                        className="flex flex-col sm:flex-row sm:items-center gap-2 p-2.5 rounded-lg bg-[#0A130E] border border-[#D4AF37]/14"
                      >
                        <button
                          type="button"
                          onClick={() => setSeekTime(Number(relSegStart.toFixed(2)))}
                          title="Jump video preview to this line"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#132219] hover:bg-[#192E22] border border-[#10B981]/30 font-mono text-[11px] text-[#F5C451] tabular-nums shrink-0"
                        >
                          <Play className="w-3 h-3 text-[#10B981]" />
                          {formatTimecode(relSegStart, true)}
                        </button>

                        <input
                          type="text"
                          dir={isRtlText(seg.text) ? 'rtl' : 'ltr'}
                          value={seg.text}
                          onChange={(e) => {
                            const nextVal = e.target.value;
                            setEditedSegments((prev) => {
                              const list = prev ? [...prev] : baseSegments.map((s) => ({ ...s }));
                              list[idx] = rebuildWordTimings(list[idx], nextVal);
                              return list;
                            });
                          }}
                          className="flex-1 h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                        />

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            title="Shift this line 100ms earlier"
                            onClick={() => {
                              setEditedSegments((prev) => {
                                const list = prev ? [...prev] : baseSegments.map((s) => ({ ...s }));
                                const cur = list[idx];
                                const nextStart = Math.max(0, Number((cur.start - 0.1).toFixed(3)));
                                const nextEnd = Math.max(nextStart + 0.25, Number((cur.end - 0.1).toFixed(3)));
                                list[idx] = rebuildWordTimings(
                                  { ...cur, start: nextStart, end: nextEnd },
                                  cur.text
                                );
                                return list;
                              });
                            }}
                            className="h-8 px-2 rounded bg-[#0E1913] hover:bg-[#16271E] border border-white/10 font-mono text-[10px] text-zinc-300"
                          >
                            -0.1s
                          </button>
                          <button
                            type="button"
                            title="Shift this line 100ms later"
                            onClick={() => {
                              setEditedSegments((prev) => {
                                const list = prev ? [...prev] : baseSegments.map((s) => ({ ...s }));
                                const cur = list[idx];
                                const nextStart = Number((cur.start + 0.1).toFixed(3));
                                const nextEnd = Number((cur.end + 0.1).toFixed(3));
                                list[idx] = rebuildWordTimings(
                                  { ...cur, start: nextStart, end: nextEnd },
                                  cur.text
                                );
                                return list;
                              });
                            }}
                            className="h-8 px-2 rounded bg-[#0E1913] hover:bg-[#16271E] border border-white/10 font-mono text-[10px] text-zinc-300"
                          >
                            +0.1s
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
