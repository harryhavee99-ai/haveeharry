import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  Play,
  RefreshCw,
  Search,
  ArrowRight,
  UploadCloud,
} from 'lucide-react';
import type { NavPage, ProjectRecord } from '../../shared/types.ts';
import { formatDurationHuman, formatTimecode, isRtlText } from '../lib/format.ts';

interface AnalysisPageProps {
  project: ProjectRecord | null;
  onResumeOrStart: (projectId: string, restartHighlightsOnly?: boolean) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

export function AnalysisPage({ project, onResumeOrStart, onNavigate }: AnalysisPageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [triggering, setTriggering] = useState(false);

  const filteredTranscript = useMemo(() => {
    if (!project) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return project.transcript;
    return project.transcript.filter(
      (s) => s.text.toLowerCase().includes(q) || s.speaker.toLowerCase().includes(q)
    );
  }, [project, searchQuery]);

  if (!project) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">No Active Project Selected</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Upload a video first to inspect the AI transcription, scene detection, and highlight pipeline.
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

  const completedStages = project.pipelineStages.filter((s) => s.status === 'completed').length;
  const overallProgress = Math.round(
    project.pipelineStages.reduce((sum, s) => sum + s.progress, 0) /
      Math.max(1, project.pipelineStages.length)
  );

  const jumpToTime = (sec: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      void videoRef.current.play();
    }
  };

  const handleAction = async (highlightsOnly = false) => {
    setTriggering(true);
    try {
      await onResumeOrStart(project.id, highlightsOnly);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-white truncate">
            AI Video Intelligence Pipeline
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400 tabular-nums">
            <span className="text-zinc-200 font-medium">{project.name}</span>
            <span aria-hidden="true">·</span>
            <span>{project.metadata ? formatDurationHuman(project.metadata.duration) : 'Probing...'}</span>
            <span aria-hidden="true">·</span>
            <span>
              {completedStages} of {project.pipelineStages.length} stages completed ({overallProgress}%)
            </span>
            {project.detectedLanguage && (
              <>
                <span aria-hidden="true">·</span>
                <span>Language: {project.detectedLanguage}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {(project.status === 'failed' || project.status === 'uploaded') && (
            <button
              onClick={() => void handleAction(false)}
              disabled={triggering}
              className="studio-btn-primary inline-flex items-center gap-2 h-10 px-4 rounded-lg text-sm font-medium text-white whitespace-nowrap"
            >
              {triggering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              {project.status === 'failed' ? 'Resume From Checkpoint' : 'Start AI Analysis'}
            </button>
          )}
          {project.status === 'ready' && (
            <>
              <button
                onClick={() => void handleAction(true)}
                disabled={triggering}
                className="inline-flex items-center gap-2 h-10 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-zinc-200 whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5 text-[#F5C451]" />
                Re-Select Highlights
              </button>
              <button
                onClick={() => onNavigate('clips')}
                className="studio-btn-primary inline-flex items-center gap-2 h-10 px-4 rounded-lg text-sm font-semibold text-white whitespace-nowrap"
              >
                View {project.clips.length} Clips
                <ArrowRight className="w-4 h-4 text-[#FEF3C7]" />
              </button>
            </>
          )}
        </div>
      </div>

      {project.errorMessage && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-200">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-red-100">Pipeline paused with error</div>
            <p className="mt-0.5 text-red-200/85">{project.errorMessage}</p>
          </div>
        </div>
      )}

      {/* Stage Checkpoints + Source Player */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* 7-Stage Pipeline Progress */}
        <div className="xl:col-span-5 p-5 rounded-xl studio-panel space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-white">
              Background Processing Stages
            </h2>
            <span className="font-mono text-xs text-[#F5C451] tabular-nums">
              {overallProgress}%
            </span>
          </div>

          <div className="h-2 rounded-full bg-[#132219] overflow-hidden">
            <div
              style={{ width: `${overallProgress}%` }}
              className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-300"
            />
          </div>

          <div className="space-y-3 pt-1">
            {project.pipelineStages.map((stage) => (
              <div
                key={stage.key}
                className="flex items-start gap-3 py-2 border-b border-[#D4AF37]/10 last:border-b-0"
              >
                <div className="mt-0.5 shrink-0">
                  {stage.status === 'completed' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  )}
                  {stage.status === 'running' && (
                    <Loader2 className="w-4 h-4 text-[#F5C451] animate-spin" />
                  )}
                  {stage.status === 'failed' && (
                    <AlertCircle className="w-4 h-4 text-red-400" />
                  )}
                  {stage.status === 'pending' && <Circle className="w-4 h-4 text-zinc-600" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-100">{stage.label}</span>
                    <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                      {stage.progress}%
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{stage.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Source Video + Timestamped Transcript */}
        <div className="xl:col-span-7 space-y-5">
          {project.sourceUrl && (
            <div className="rounded-xl studio-panel overflow-hidden">
              <div className="aspect-video bg-black">
                <video
                  ref={videoRef}
                  src={project.sourceUrl}
                  poster={project.thumbnailUrl}
                  controls
                  className="w-full h-full object-contain"
                />
              </div>
            </div>
          )}

          {/* Timestamped Verbatim Transcript */}
          <div className="rounded-xl studio-panel overflow-hidden">
            <div className="p-4 border-b border-[#D4AF37]/12 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-white">
                  Timestamped Speech Transcript
                </h2>
                <p className="text-xs text-zinc-400 tabular-nums">
                  {project.transcript.length} segments · Click any line to seek original video
                </p>
              </div>
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search spoken words..."
                  className="w-full h-8 pl-8 pr-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            </div>

            <div className="max-h-[380px] overflow-y-auto divide-y divide-[#D4AF37]/8">
              {filteredTranscript.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500">
                  {project.status === 'analyzing'
                    ? 'Speech-to-text transcription is running in chunks...'
                    : 'No transcript segments available yet.'}
                </div>
              ) : (
                filteredTranscript.map((seg) => (
                  <button
                    key={seg.id}
                    onClick={() => jumpToTime(seg.start)}
                    className="w-full text-left px-4 py-3 hover:bg-[#059669]/10 transition-colors flex items-start gap-3"
                  >
                    <span className="font-mono text-[11px] text-[#F5C451] tabular-nums shrink-0 mt-0.5 flex items-center gap-1">
                      <Play className="w-3 h-3" />
                      {formatTimecode(seg.start)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium text-emerald-300/80">{seg.speaker}</div>
                      <p
                        dir={isRtlText(seg.text) ? 'rtl' : 'ltr'}
                        className="mt-0.5 text-sm text-zinc-200 leading-relaxed"
                      >
                        {seg.text}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Detected Visual Keyframes & Speaker Framing Map */}
          {project.scenes.length > 0 && (
            <div className="p-4 rounded-xl studio-panel">
              <h2 className="font-display text-sm font-semibold text-white mb-3">
                Visual Keyframes & Active Speaker Coordinates
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {project.scenes.slice(0, 8).map((sc, i) => (
                  <button
                    key={`${sc.time}-${i}`}
                    onClick={() => jumpToTime(sc.time)}
                    className="text-left group rounded-lg overflow-hidden bg-[#0C1510] border border-[#D4AF37]/15 hover:border-[#D4AF37]/60 transition-colors"
                  >
                    <div className="aspect-video bg-black relative overflow-hidden">
                      {sc.keyframeUrl && (
                        <img
                          src={sc.keyframeUrl}
                          alt={sc.description || `Scene at ${formatTimecode(sc.time)}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      )}
                      {sc.speakerX !== undefined && sc.speakerY !== undefined && (
                        <div
                          style={{
                            left: `${sc.speakerX * 100}%`,
                            top: `${sc.speakerY * 100}%`,
                          }}
                          className="absolute w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#D4AF37] bg-[#059669]/40"
                        />
                      )}
                    </div>
                    <div className="p-2">
                      <div className="font-mono text-[11px] text-[#F5C451] tabular-nums">
                        {formatTimecode(sc.time)}
                      </div>
                      {sc.description && (
                        <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                          {sc.description}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
