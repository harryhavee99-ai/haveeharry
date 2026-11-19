import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { MusicTrack } from '../shared/types.ts';
import { MUSIC_DIR } from './store.ts';

const execFileAsync = promisify(execFile);

interface TrackSpec extends Omit<MusicTrack, 'url'> {
  filename: string;
  filterExpr: string;
}

const TRACK_SPECS: TrackSpec[] = [
  {
    id: 'podcast-warm-bed',
    name: 'Warm Studio Bed',
    category: 'Podcast',
    bpm: 88,
    duration: 24,
    description: 'Subtle warm harmonic pad designed to sit cleanly beneath spoken interviews.',
    filename: 'podcast-warm-bed.mp3',
    filterExpr:
      "aevalsrc='0.14*sin(2*PI*130.81*t)+0.10*sin(2*PI*196.00*t)+0.08*sin(2*PI*246.94*t)+0.05*sin(2*PI*329.63*t)*(0.6+0.4*sin(2*PI*0.25*t))':s=44100:d=24",
  },
  {
    id: 'lofi-focus',
    name: 'Midnight Lo-Fi Drift',
    category: 'Lo-Fi',
    bpm: 76,
    duration: 24,
    description: 'Soft mellow minor-seventh chord progression with gentle rhythmic pulse.',
    filename: 'lofi-focus.mp3',
    filterExpr:
      "aevalsrc='(0.12*sin(2*PI*174.61*t)+0.09*sin(2*PI*220.00*t)+0.08*sin(2*PI*261.63*t)+0.06*sin(2*PI*329.63*t))*(0.7+0.3*sin(2*PI*1.26*t))':s=44100:d=24",
  },
  {
    id: 'cinematic-pulse',
    name: 'Cinematic Horizon',
    category: 'Cinematic',
    bpm: 96,
    duration: 24,
    description: 'Deep sub-bass foundation with atmospheric fifths for dramatic storytelling.',
    filename: 'cinematic-pulse.mp3',
    filterExpr:
      "aevalsrc='0.16*sin(2*PI*73.42*t)+0.10*sin(2*PI*146.83*t)*(0.55+0.45*sin(2*PI*0.5*t))+0.07*sin(2*PI*220.00*t)+0.05*sin(2*PI*293.66*t)':s=44100:d=24",
  },
  {
    id: 'upbeat-creator',
    name: 'Creator Momentum',
    category: 'Upbeat',
    bpm: 118,
    duration: 24,
    description: 'Energetic rhythmic arpeggio texture tailored for fast-paced Shorts and Reels.',
    filename: 'upbeat-creator.mp3',
    filterExpr:
      "aevalsrc='(0.12*sin(2*PI*261.63*t)+0.09*sin(2*PI*329.63*t)+0.08*sin(2*PI*392.00*t))*(0.55+0.45*sin(2*PI*3.93*t))+0.08*sin(2*PI*130.81*t)':s=44100:d=24",
  },
  {
    id: 'ambient-clarity',
    name: 'Airy Documentary Pad',
    category: 'Ambient',
    bpm: 70,
    duration: 24,
    description: 'Clean minimal soundscape suited for educational and documentary clips.',
    filename: 'ambient-clarity.mp3',
    filterExpr:
      "aevalsrc='0.11*sin(2*PI*196.00*t)+0.09*sin(2*PI*293.66*t)+0.07*sin(2*PI*392.00*t)*(0.65+0.35*sin(2*PI*0.18*t))':s=44100:d=24",
  },
  {
    id: 'corporate-modern',
    name: 'Executive Keynote',
    category: 'Corporate',
    bpm: 104,
    duration: 24,
    description: 'Polished modern tonal backdrop ideal for business insights and founder clips.',
    filename: 'corporate-modern.mp3',
    filterExpr:
      "aevalsrc='(0.12*sin(2*PI*220.00*t)+0.09*sin(2*PI*277.18*t)+0.08*sin(2*PI*329.63*t))*(0.65+0.35*sin(2*PI*1.73*t))+0.09*sin(2*PI*110.00*t)':s=44100:d=24",
  },
];

interface SfxSpec {
  id: 'whoosh' | 'pop' | 'chime' | 'impact';
  filename: string;
  filterExpr: string;
  postFilter: string;
}

const SFX_SPECS: SfxSpec[] = [
  {
    id: 'whoosh',
    filename: 'sfx-whoosh.wav',
    filterExpr: 'anoisesrc=d=0.6:c=pink:r=44100:a=0.45',
    postFilter: 'bandpass=f=900:width_type=h:w=700,afade=t=in:d=0.18,afade=t=out:st=0.25:d=0.35',
  },
  {
    id: 'pop',
    filename: 'sfx-pop.wav',
    filterExpr: "aevalsrc='0.5*sin(2*PI*(650-450*t)*t)*exp(-14*t)':s=44100:d=0.25",
    postFilter: 'volume=0.8',
  },
  {
    id: 'chime',
    filename: 'sfx-chime.wav',
    filterExpr: "aevalsrc='(0.32*sin(2*PI*880*t)+0.22*sin(2*PI*1318.5*t))*exp(-4*t)':s=44100:d=0.9",
    postFilter: 'volume=0.75',
  },
  {
    id: 'impact',
    filename: 'sfx-impact.wav',
    filterExpr: "aevalsrc='0.65*sin(2*PI*(110-70*t)*t)*exp(-5.5*t)':s=44100:d=0.6",
    postFilter: 'lowpass=f=220',
  },
];

const inFlight = new Map<string, Promise<string | null>>();

async function synthesizeTrack(spec: TrackSpec): Promise<string | null> {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const outPath = path.join(MUSIC_DIR, spec.filename);
  if (fs.existsSync(outPath)) return outPath;

  const existing = inFlight.get(spec.filename);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        spec.filterExpr,
        '-af',
        'lowpass=f=1800,afade=t=in:d=1.2,afade=t=out:st=22.5:d=1.5',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        outPath,
      ]);
      return fs.existsSync(outPath) ? outPath : null;
    } catch (err) {
      console.error(`Failed to synthesize royalty-free track ${spec.id}:`, err);
      return null;
    } finally {
      inFlight.delete(spec.filename);
    }
  })();

  inFlight.set(spec.filename, promise);
  return promise;
}

async function synthesizeSfx(spec: SfxSpec): Promise<string | null> {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const outPath = path.join(MUSIC_DIR, spec.filename);
  if (fs.existsSync(outPath)) return outPath;

  const existing = inFlight.get(spec.filename);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        spec.filterExpr,
        '-af',
        spec.postFilter,
        outPath,
      ]);
      return fs.existsSync(outPath) ? outPath : null;
    } catch (err) {
      console.error(`Failed to synthesize SFX ${spec.id}:`, err);
      return null;
    } finally {
      inFlight.delete(spec.filename);
    }
  })();

  inFlight.set(spec.filename, promise);
  return promise;
}

export function getMusicTracks(): MusicTrack[] {
  return TRACK_SPECS.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    bpm: t.bpm,
    duration: t.duration,
    description: t.description,
    url: `/media/music/${t.filename}`,
  }));
}

export async function ensureMusicFileByName(filename: string): Promise<string | null> {
  const track = TRACK_SPECS.find((t) => t.filename === filename);
  if (track) return synthesizeTrack(track);
  const sfx = SFX_SPECS.find((s) => s.filename === filename);
  if (sfx) return synthesizeSfx(sfx);
  return null;
}

export async function getMusicTrackPath(trackId: string | null): Promise<string | null> {
  if (!trackId) return null;
  const spec = TRACK_SPECS.find((t) => t.id === trackId);
  if (!spec) return null;
  return synthesizeTrack(spec);
}

export async function getSfxPath(sfxId: string): Promise<string | null> {
  const spec = SFX_SPECS.find((s) => s.id === sfxId);
  if (!spec) return null;
  return synthesizeSfx(spec);
}
