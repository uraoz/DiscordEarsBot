import {
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
    entersState,
    EndBehaviorType,
    VoiceConnectionDisconnectReason,
} from "@discordjs/voice";
import {
    VoiceBasedChannel,
    TextBasedChannel,
    Client,
    GuildMember,
} from "discord.js";
import { opus } from "prism-media";
import { ResampleTransform } from "./audio-pipeline";
import { STTClient, TranscriptionResult } from "./stt-client";
import { config } from "./config";
import { Readable } from "stream";

/**
 * ユーザーごとのストリームリソース管理。
 * メモリリーク防止のため、全リソースをトラッキングして確実に破棄する。
 */
interface UserStreamResources {
    sttClient: STTClient;
    opusStream: Readable;
    decoder: opus.Decoder;
    resampler: ResampleTransform;
}

/**
 * レート制限対策: ユーザーごとの認識結果を一時バッファし、
 * 500ms間まとめて1メッセージにする。
 */
interface MessageBuffer {
    texts: string[];
    timer: NodeJS.Timeout | null;
}

export class VoiceHandler {
    private connection: VoiceConnection | null = null;
    private userResources: Map<string, UserStreamResources> = new Map();
    private textChannel: TextBasedChannel;
    private client: Client;
    private guildId: string;
    /** ユーザー名キャッシュ（毎回fetchしない） */
    private displayNameCache: Map<string, string> = new Map();
    /** レート制限対策用メッセージバッファ */
    private messageBuffers: Map<string, MessageBuffer> = new Map();
    /** メッセージバッファのフラッシュ間隔（ms） */
    private readonly MESSAGE_BUFFER_MS = 500;

    constructor(client: Client, textChannel: TextBasedChannel, guildId: string) {
        this.client = client;
        this.textChannel = textChannel;
        this.guildId = guildId;
    }

    async join(channel: VoiceBasedChannel): Promise<void> {
        this.connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false, // 重要: 他ユーザーの音声を受信するためdeafをOFFにする
        });

        // VoiceConnection の状態変更を監視（メモリリーク防止）
        this.connection.on("stateChange", (_oldState, newState) => {
            if (newState.status === VoiceConnectionStatus.Disconnected) {
                // 予期しない切断の場合、全リソースをクリーンアップ
                if (
                    (newState as any).reason ===
                    VoiceConnectionDisconnectReason.WebSocketClose
                ) {
                    console.log("Voice connection disconnected unexpectedly, cleaning up");
                    this.cleanupAllUsers();
                }
            }
        });

        await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
        console.log(`Joined voice channel: ${channel.name}`);

        // receiver からユーザーごとの音声ストリームを取得
        const receiver = this.connection.receiver;

        receiver.speaking.on("start", async (userId: string) => {
            // 既にストリーム処理中ならスキップ
            if (this.userResources.has(userId)) return;

            console.log(`User ${userId} started speaking`);
            await this.startListening(userId);
        });
    }

    private async startListening(userId: string): Promise<void> {
        if (!this.connection) return;

        const receiver = this.connection.receiver;

        // Opus ストリームを subscribe
        const opusStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterInactivity,
                duration: 60_000, // 60秒無音で自動終了（メモリリーク防止）
            },
        });

        // Opus → PCM 48kHz stereo
        const decoder = new opus.Decoder({
            rate: 48000,
            channels: 2,
            frameSize: 960,
        });

        // PCM 48kHz stereo → PCM 16kHz mono
        const resampler = new ResampleTransform();

        // STTサーバーへの WebSocket 接続
        const sttClient = new STTClient(config.stt.serverUrl, userId);

        // リソースをトラッキング
        const resources: UserStreamResources = {
            sttClient,
            opusStream,
            decoder,
            resampler,
        };
        this.userResources.set(userId, resources);

        sttClient.on("transcription", (result: TranscriptionResult) => {
            this.onTranscription(userId, result);
        });

        sttClient.on("reconnect_failed", () => {
            console.error(`STT reconnection failed for ${userId}, stopping listener`);
            this.stopListening(userId);
        });

        try {
            await sttClient.connect();
        } catch (e) {
            console.error(`Failed to connect STT for ${userId}:`, e);
            this.stopListening(userId);
            return;
        }

        // パイプライン接続
        opusStream.pipe(decoder).pipe(resampler);

        resampler.on("data", (chunk: Buffer) => {
            sttClient.sendAudio(chunk);
        });

        // ストリーム終了時のクリーンアップ（メモリリーク防止）
        opusStream.on("end", () => {
            console.log(`User ${userId} opus stream ended`);
            this.stopListening(userId);
        });

        opusStream.on("close", () => {
            console.log(`User ${userId} opus stream closed`);
            this.stopListening(userId);
        });

        opusStream.on("error", (err: Error) => {
            console.error(`Opus stream error for ${userId}:`, err);
            this.stopListening(userId);
        });

        decoder.on("error", (err: Error) => {
            console.error(`Decoder error for ${userId}:`, err);
            this.stopListening(userId);
        });

        resampler.on("error", (err: Error) => {
            console.error(`Resampler error for ${userId}:`, err);
            this.stopListening(userId);
        });
    }

    /**
     * レート制限対策: 認識結果を500msバッファしてまとめて送信
     */
    private async onTranscription(
        userId: string,
        result: TranscriptionResult
    ): Promise<void> {
        let buffer = this.messageBuffers.get(userId);
        if (!buffer) {
            buffer = { texts: [], timer: null };
            this.messageBuffers.set(userId, buffer);
        }

        buffer.texts.push(result.text);

        // 既存タイマーがなければフラッシュタイマーを設定
        if (!buffer.timer) {
            buffer.timer = setTimeout(() => {
                this.flushMessageBuffer(userId);
            }, this.MESSAGE_BUFFER_MS);
        }
    }

    private async flushMessageBuffer(userId: string): Promise<void> {
        const buffer = this.messageBuffers.get(userId);
        if (!buffer || buffer.texts.length === 0) return;

        const combinedText = buffer.texts.join(" ");
        buffer.texts = [];
        buffer.timer = null;

        try {
            const displayName = await this.getDisplayName(userId);
            if ("send" in this.textChannel) {
                await this.textChannel.send(`**${displayName}**: ${combinedText}`);
            }
        } catch (e) {
            console.error("Failed to send transcription:", e);
        }
    }

    /**
     * ユーザー名をキャッシュして取得（Phase 4-1 改善）
     */
    private async getDisplayName(userId: string): Promise<string> {
        const cached = this.displayNameCache.get(userId);
        if (cached) return cached;

        try {
            const guild = this.client.guilds.cache.get(this.guildId);
            if (guild) {
                const member = await guild.members.fetch(userId);
                const name = member.displayName;
                this.displayNameCache.set(userId, name);
                return name;
            }
        } catch (e) {
            console.error(`Failed to fetch display name for ${userId}:`, e);
        }

        return userId; // フォールバック
    }

    /**
     * 特定ユーザーのストリームリソースを全て破棄
     */
    private stopListening(userId: string): void {
        const resources = this.userResources.get(userId);
        if (!resources) return;

        resources.sttClient.disconnect();
        resources.resampler.removeAllListeners();
        resources.resampler.destroy();
        resources.decoder.removeAllListeners();
        resources.decoder.destroy();
        resources.opusStream.removeAllListeners();
        resources.opusStream.destroy();

        this.userResources.delete(userId);

        // メッセージバッファも即座にフラッシュ
        const buffer = this.messageBuffers.get(userId);
        if (buffer) {
            if (buffer.timer) clearTimeout(buffer.timer);
            if (buffer.texts.length > 0) {
                this.flushMessageBuffer(userId);
            }
            this.messageBuffers.delete(userId);
        }

        console.log(`Cleaned up resources for ${userId}`);
    }

    /**
     * 全ユーザーのリソースをクリーンアップ
     */
    private cleanupAllUsers(): void {
        for (const userId of this.userResources.keys()) {
            this.stopListening(userId);
        }
    }

    disconnect(): void {
        this.cleanupAllUsers();
        this.displayNameCache.clear();
        this.connection?.destroy();
        this.connection = null;
    }
}
