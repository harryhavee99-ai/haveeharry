export type ProcessingMode = 'auto_clips' | 'captions_only';
export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5' | '4:3' | 'original';
export type FramingMode = 'ai_auto' | 'face_track' | 'manual';
export type MotionIntensity = 'minimal' | 'balanced' | 'dynamic';
export type CaptionAnimation =
  | 'pop'
  | 'karaoke'
  | 'wave'
  | 'bounce'
  | 'typewriter'
  | 'shake'
  | 'neon_pulse'
  | 'flip'
  | 'fade'
  | 'slide'
  | 'glow'
  | 'none';
export type CaptionPosition = 'top' | 'middle' | 'bottom';
export type CaptionAlignment = 'left' | 'center' | 'right';
export type ExportResolution = '720p' | '1080p' | '4k' | 'original';
export type ExportCodec = 'h264' | 'h265';
export type ExportFps = 24 | 30 | 60 | 'original';

export type ClipCategory =
  | 'interesting'
  | 'educational'
  | 'funny'
  | 'emotional'
  | 'informative'
  | 'storytelling'
  | 'debate'
  | 'hook';

export type ProjectStatus =
  | 'uploading'
  | 'uploaded'
  | 'analyzing'
  | 'ready'
  | 'failed';

export type PipelineStageKey =
  | 'probe'
  | 'audio_chunks'
  | 'signal_analysis'
  | 'transcription'
  | 'visual_framing'
  | 'hook_discovery'
  | 'hook_scoring'
  | 'hook_verification'
  | 'clip_generation'
  | 'clip_rendering'
  // Legacy keys kept for backward compatibility with existing saved projects in data/db.json
  | 'highlight_selection'
  | 'clip_thumbnails';

export interface PipelineStageState {
  key: PipelineStageKey;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  detail: string;
  updatedAt?: string;
}

export interface AudioEnergyPoint {
  start: number;
  end: number;
  rmsDb: number; // e.g. -60..0 dB
  peakDb: number;
  normalizedEnergy: number; // 0..100 relative energy
}

export interface HookScoringWeights {
  openingHook: number; // default 20
  curiosityInterest: number; // default 15
  emotionalEngagement: number; // default 15
  infoEntertainment: number; // default 15
  storyCompleteness: number; // default 15
  standaloneContext: number; // default 10
  audioVisualQuality: number; // default 10
}

export interface HookScoreBreakdown {
  total: number; // 0..100 weighted total
  openingHook: number; // 0..20 (or scaled to weight)
  curiosityInterest: number; // 0..15
  emotionalEngagement: number; // 0..15
  infoEntertainment: number; // 0..15
  storyCompleteness: number; // 0..15
  standaloneContext: number; // 0..10
  audioVisualQuality: number; // 0..10
  // Auxiliary 0..100 sort dimensions for Hook Intelligence views
  surprisingScore: number;
  storytellingScore: number;
  entertainingScore: number;
  informativeScore: number;
  emotionalScore: number;
}

export type HookCandidateStatus =
  | 'discovered'
  | 'verified'
  | 'approved'
  | 'rejected'
  | 'generated';

export interface HookCandidate {
  id: string;
  projectId: string;
  title: string;
  topic: string;
  openingDialogue: string;
  endingDialogue: string;
  transcriptExcerpt: string;
  startTime: number;
  endTime: number;
  duration: number;
  description: string;
  reasonSelected: string;
  verificationNotes?: string;
  rejectedReasons?: string[];
  category: ClipCategory;
  hookTitle: string;
  speakerLabel: string;
  emphasizedKeywords: string[];
  scores: ClipScoreBreakdown;
  hookBreakdown: HookScoreBreakdown;
  audioEnergyScore: number;
  status: HookCandidateStatus;
  clipId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WordTiming {
  id: string;
  word: string;
  start: number; // seconds relative to original video
  end: number;
  emphasis?: boolean;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  speaker: string;
  text: string;
  words: WordTiming[];
  chunkIndex: number;
}

export interface SceneMarker {
  time: number;
  score: number;
  speakerX?: number; // 0..1 normalized focal X
  speakerY?: number; // 0..1 normalized focal Y
  description?: string;
  keyframeUrl?: string;
}

export interface CaptionStyleConfig {
  presetId: string;
  enabled: boolean;
  fontFamily: string;
  fontSize: number; // 18..64
  fontWeight: 500 | 600 | 700 | 800;
  textColor: string;
  highlightColor: string;
  backgroundColor: string;
  backgroundOpacity: number; // 0..1
  strokeColor: string;
  strokeWidth: number; // 0..6
  shadow: boolean;
  position: CaptionPosition;
  verticalOffset: number; // 5..90 percentage from top
  alignment: CaptionAlignment;
  lineSpacing: number; // 1.0..1.8
  animation: CaptionAnimation;
  wordsPerLine: number; // 2..10
  maxLines: 1 | 2 | 3;
  timingOffsetMs: number; // -2000..2000
  uppercase: boolean;
  wordLevelHighlight: boolean;
  // Advanced Animation, Pill, Typography & Voiceover Sync Controls
  animationSpeed?: number; // 0.5..2.0 (default 1.0)
  waveAmplitude?: number; // 2..18 px (default 7)
  activeWordScale?: number; // 1.0..1.35 (default 1.1)
  activeWordBgColor?: string; // active word pill color
  activeWordBgOpacity?: number; // 0..1 (default 0)
  letterSpacing?: number; // -1..8 px (default 0)
  wordSpacing?: number; // 0..18 px (default 4)
  backgroundRadius?: number; // 0..24 px (default 10)
  backgroundPadding?: number; // 4..24 px (default 12)
  horizontalOffset?: number; // 10..90 % from left (default 50)
  italic?: boolean;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  glowIntensity?: number; // 0..28 px (default 14)
  shadowColor?: string; // default '#000000'
  shadowBlur?: number; // 0..24 px (default 10)
  wordLeadInMs?: number; // -150..150 ms (default 35ms perceptual vocal onset lead-in)
  // Per-Effect Independent Opacity Controls (0..1, default 1.0)
  textOpacity?: number; // 0..1 (default 1)
  highlightOpacity?: number; // 0..1 (default 1)
  strokeOpacity?: number; // 0..1 (default 1)
  shadowOpacity?: number; // 0..1 (default 0.85)
  glowOpacity?: number; // 0..1 (default 0.9)
}

export interface ColorGradingConfig {
  stylePresetId: string;
  brightness: number; // -0.3..0.3
  contrast: number; // 0.6..1.6
  saturation: number; // 0..2.0
  temperature: number; // -0.4..0.4
  highlights: number; // -0.3..0.3
  shadows: number; // -0.3..0.3
  sharpness: number; // 0..2.0
  exposure: number; // -0.3..0.3
  aiEnhance: boolean;
}

export interface TextOverlayItem {
  id: string;
  text: string;
  startOffset: number; // seconds relative to clip start
  endOffset: number;
  x: number; // 0..100 %
  y: number; // 0..100 %
  fontSize: number;
  color: string;
  bgColor: string;
  style: 'title' | 'callout' | 'lower_third' | 'badge';
}

export interface MotionGraphicsConfig {
  intensity: MotionIntensity;
  hookTitleEnabled: boolean;
  hookTitleText: string;
  hookDuration: number; // seconds
  dynamicZoom: boolean;
  zoomAmount: number; // 1.0..1.35
  punchInOnEmphasis: boolean;
  cameraMovement: 'none' | 'subtle_pan' | 'ken_burns';
  keywordCallouts: boolean;
  emphasizedKeywords: string[];
  progressBar: 'none' | 'top' | 'bottom';
  progressBarColor: string;
  lowerThirdEnabled: boolean;
  speakerLabel: string;
  speakerRole: string;
  emojiReactions: boolean;
  animatedShapes: boolean;
  subtleTransitions: boolean;
  backgroundBlur: boolean;
  pipLayout: boolean;
}

export interface AudioMixConfig {
  originalVolume: number; // 0..1.5
  musicTrackId: string | null;
  musicVolume: number; // 0..1.0
  fadeInSeconds: number; // 0..5
  fadeOutSeconds: number; // 0..5
  autoDucking: boolean;
  sfxOnHook: 'none' | 'whoosh' | 'pop' | 'chime' | 'impact';
}

export interface FramingConfig {
  aspectRatio: AspectRatio;
  mode: FramingMode;
  manualX: number; // 0..1 focal point X
  manualY: number; // 0..1 focal point Y
  zoom: number; // 1.0..2.0
  focalKeyframes: Array<{ time: number; x: number; y: number }>;
}

export interface ClipScoreBreakdown {
  overall: number; // 0..100 AI estimate
  hookStrength: number;
  engagement: number;
  educationalValue: number;
  emotionalImpact: number;
  humor: number;
  informationValue: number;
  storyCompleteness: number;
}

export type ClipRenderStatus =
  | 'not_rendered'
  | 'queued'
  | 'rendering'
  | 'validating'
  | 'saving'
  | 'export_ready'
  | 'failed';

export interface ClipRecord {
  id: string;
  projectId: string;
  originalVideoId?: string;
  candidateId?: string;
  isFullVideoCaption?: boolean;
  preserveOriginalVideo?: boolean;
  title: string;
  topic?: string;
  openingDialogue?: string;
  endingDialogue?: string;
  description: string;
  reasonSelected: string;
  category: ClipCategory;
  startTime: number; // seconds in original source
  endTime: number;
  duration: number;
  scores: ClipScoreBreakdown;
  hookBreakdown?: HookScoreBreakdown;
  editingStatus: 'auto_generated' | 'edited' | 'rendered';
  renderStatus?: ClipRenderStatus;
  renderStageDetail?: string;
  renderError?: string;
  thumbnailUrl: string;
  renderedVideoUrl?: string;
  storageObjectPath?: string;
  mp4Filename?: string;
  renderedFileSize?: number;
  renderedDuration?: number;
  renderedResolution?: string;
  renderedAt?: string;
  lastExportConfig?: ExportOptions;
  framing: FramingConfig;
  captionStyle: CaptionStyleConfig;
  colorGrading: ColorGradingConfig;
  motionGraphics: MotionGraphicsConfig;
  audioMix: AudioMixConfig;
  textOverlays: TextOverlayItem[];
  customSegments?: TranscriptSegment[]; // edited captions for this clip
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisConfig {
  mode?: ProcessingMode;
  targetClipDuration: number; // seconds (60, 120, 180, 240, 300 or custom)
  clipCount: number; // 5, 10, 15, 20, 30 or 0 for max
  language: string; // 'auto', 'en', 'ur', 'roman_ur', 'hi', 'ar', etc.
  aspectRatio: AspectRatio;
  framingMode: FramingMode;
  captionPresetId: string;
  stylePresetId: string;
  motionIntensity: MotionIntensity;
}

export interface VideoMetadata {
  duration: number; // seconds
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixFmt?: string;
  audioCodec: string;
  bitrate: number;
  fileSize: number;
}

export interface ProjectRecord {
  id: string;
  uploadId?: string;
  processingJobId?: string;
  failedStage?: string;
  storageRef?: string;
  name: string;
  originalFilename: string;
  mimeType: string;
  status: ProjectStatus;
  errorMessage?: string;
  uploadProgress: number; // 0..100
  uploadedChunks: number[];
  totalChunks: number;
  fileSize: number;
  sourcePath?: string;
  sourceUrl?: string;
  originalContainer?: string;
  thumbnailUrl?: string;
  metadata?: VideoMetadata;
  analysisConfig: AnalysisConfig;
  pipelineStages: PipelineStageState[];
  completedAudioChunks: number;
  totalAudioChunks: number;
  completedTranscriptChunks: number;
  transcript: TranscriptSegment[];
  silences: Array<{ start: number; end: number }>;
  audioEnergy?: AudioEnergyPoint[];
  scenes: SceneMarker[];
  detectedLanguage?: string;
  hookCandidates?: HookCandidate[];
  hookSelectionNote?: string;
  browserProxyStatus?: 'ready' | 'transcoding' | 'failed';
  clips: ClipRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ExportOptions {
  resolution: ExportResolution;
  codec: ExportCodec;
  fps: ExportFps;
  quality?: 'standard' | 'excellent' | 'master';
  embedCaptions: boolean;
  includeMusic: boolean;
}

export type ExportStage =
  | 'queued'
  | 'rendering_mp4'
  | 'validating_mp4'
  | 'saving_storage'
  | 'export_ready'
  | 'failed';

export interface Mp4ValidationMeta {
  container: string;
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  duration: number;
  fileSize: number;
}

export interface ExportJob {
  id: string;
  projectId: string;
  clipId: string;
  clipTitle: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  stage?: ExportStage;
  stageDetail?: string;
  progress: number;
  options: ExportOptions;
  outputUrl?: string;
  storageObjectPath?: string;
  mp4Filename?: string;
  fileSize?: number;
  validationMeta?: Mp4ValidationMeta;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface MusicTrack {
  id: string;
  name: string;
  category: 'Podcast' | 'Cinematic' | 'Lo-Fi' | 'Upbeat' | 'Ambient' | 'Corporate';
  bpm: number;
  duration: number;
  description: string;
  url: string;
}

export interface AppSettings {
  defaultLanguage: string;
  defaultClipDuration: number;
  defaultClipCount: number;
  defaultAspectRatio: AspectRatio;
  defaultFramingMode: FramingMode;
  defaultCaptionPresetId: string;
  defaultStylePresetId: string;
  defaultMotionIntensity: MotionIntensity;
  defaultExportResolution: ExportResolution;
  defaultExportCodec: ExportCodec;
  defaultExportFps: ExportFps;
  hookScoringWeights?: HookScoringWeights;
}

export interface SystemCapabilities {
  geminiConfigured: boolean;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  h265Supported: boolean;
  maxUploadDurationHours: number;
}

export type NavPage =
  | 'dashboard'
  | 'upload'
  | 'analysis'
  | 'clips'
  | 'editor'
  | 'captions'
  | 'motion'
  | 'export'
  | 'history'
  | 'settings';
