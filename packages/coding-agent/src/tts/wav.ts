import { encodePcm16Wav } from "../stt/wav";

/**
 * Assemble a mono PCM16 WAV byte buffer from Float32 PCM samples (normalized
 * [-1, 1] amplitudes plus a sample rate).
 *
 * @deprecated Duplicate RIFF writer; use `encodePcm16Wav([samples], sampleRate)` from `stt/wav`. Will be removed in the next major.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
	return encodePcm16Wav([samples], sampleRate);
}
