import { invoke } from "@tauri-apps/api/core";
import { runWithProgress, type AiProgress } from "./ai";

/**
 * Music for the video slideshow. Published tracks download once, when first
 * picked; dev builds also list the MP3s in the project's `music` folder.
 */
export interface TrackInfo {
  id: string;
  title: string;
  sizeBytes: number;
  installed: boolean;
}

/** The sample rate of the video's audio; decoded tracks are resampled to it. */
export const MUSIC_SAMPLE_RATE = 48_000;

export const listTracks = () => invoke<TrackInfo[]>("music_tracks");

export const downloadTrack = (track: string, requestId: string, onProgress: (progress: AiProgress) => void) =>
  runWithProgress<void>("music_download", requestId, { track }, onProgress);

/** The audio file types the user can pick; the webview decodes all of them. */
export const AUDIO_FILE_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "flac"];

/** Decodes audio file bytes at the video's sample rate. */
const decodeBytes = (bytes: ArrayBuffer) => new OfflineAudioContext(2, 1, MUSIC_SAMPLE_RATE).decodeAudioData(bytes);

/** Reads a downloaded track and decodes it at the video's sample rate. */
export const decodeTrack = async (track: string) => decodeBytes(await invoke<ArrayBuffer>("music_read", { track }));

/** Reads an audio file the user picked on this PC and decodes it at the video's sample rate. */
export async function decodeAudioFile(path: string): Promise<AudioBuffer> {
  const bytes = await invoke<ArrayBuffer>("music_read_file", { path });
  try {
    return await decodeBytes(bytes);
  } catch {
    throw new Error("Could not read that file as audio. Try an MP3 file.");
  }
}

/** The loudest sample in each of `count` equal parts of the track, from 0 to 1, for drawing its waveform. */
export function trackPeaks(buffer: AudioBuffer, count: number): Float32Array {
  const peaks = new Float32Array(count);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const per = buffer.length / count;
  for (let part = 0; part < count; part++) {
    const from = Math.floor(part * per);
    const to = Math.min(buffer.length, Math.floor((part + 1) * per));
    /** Every fourth sample is enough to find the peak shape and keeps long tracks fast. */
    let peak = 0;
    for (const data of channels) {
      for (let index = from; index < to; index += 4) peak = Math.max(peak, Math.abs(data[index]));
    }
    peaks[part] = Math.min(1, peak);
  }
  return peaks;
}

/** "1:05" for 65 seconds. */
export const formatClock = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
