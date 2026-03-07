declare module "msedge-tts" {
	export const OUTPUT_FORMAT: {
		AUDIO_24KHZ_48KBITRATE_MONO_MP3: string;
	};

	export class MsEdgeTTS {
		public setMetadata(voice: string, format: string): Promise<void>;
		public toFile(
			tmpPath: string,
			inputText: string,
			settings: { pitch: string; rate: string; volume: string },
		): Promise<{ audioFilePath: string }>;
	}
}
