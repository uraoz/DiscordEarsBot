import "dotenv/config";

export const config = {
    discord: {
        token: process.env.DISCORD_TOKEN!,
        clientId: process.env.DISCORD_CLIENT_ID!,
    },
    stt: {
        serverUrl: process.env.STT_SERVER_URL || "ws://127.0.0.1:8765",
    },
    audio: {
        // Discord Opus → PCM 変換後のフォーマット
        inputSampleRate: 48000,
        inputChannels: 2, // Discord は stereo
        // STTサーバーへ送るフォーマット
        outputSampleRate: 16000,
        outputChannels: 1,
        // リサンプルのチャンク送信間隔(ms)
        chunkIntervalMs: 100,
    },
};
