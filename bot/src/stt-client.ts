import WebSocket from "ws";
import { EventEmitter } from "events";

export interface TranscriptionResult {
    userId: string;
    text: string;
}

/**
 * STTサーバーとWebSocketで通信するクライアント。
 * 指数バックオフ付き自動再接続を備える。
 */
export class STTClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private serverUrl: string;
    private userId: string;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private closed: boolean = false;

    constructor(serverUrl: string, userId: string) {
        super();
        this.serverUrl = serverUrl;
        this.userId = userId;
    }

    connect(): Promise<void> {
        this.closed = false;
        return new Promise((resolve, reject) => {
            const url = `${this.serverUrl}/ws/${this.userId}`;
            this.ws = new WebSocket(url);

            this.ws.on("open", () => {
                console.log(`[STT] Connected for user ${this.userId}`);
                this.reconnectAttempts = 0;
                resolve();
            });

            this.ws.on("message", (data: WebSocket.Data) => {
                try {
                    const result: TranscriptionResult = JSON.parse(data.toString());
                    this.emit("transcription", result);
                } catch (e) {
                    console.error("[STT] Parse error:", e);
                }
            });

            this.ws.on("close", () => {
                console.log(`[STT] Disconnected for user ${this.userId}`);
                this.emit("disconnected");
                this.attemptReconnect();
            });

            this.ws.on("error", (err) => {
                console.error(`[STT] WebSocket error for ${this.userId}:`, err.message);
                // 初回接続のエラーのみ reject する
                if (this.reconnectAttempts === 0 && this.ws?.readyState !== WebSocket.OPEN) {
                    reject(err);
                }
            });
        });
    }

    /**
     * 指数バックオフで再接続を試みる（1s → 2s → 4s → 8s → 16s）
     */
    private attemptReconnect(): void {
        if (this.closed || this.reconnectAttempts >= this.maxReconnectAttempts) {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.error(
                    `[STT] Max reconnect attempts reached for ${this.userId}`
                );
                this.emit("reconnect_failed");
            }
            return;
        }

        const delay = Math.pow(2, this.reconnectAttempts) * 1000; // 1s, 2s, 4s, 8s, 16s
        this.reconnectAttempts++;
        console.log(
            `[STT] Reconnecting for ${this.userId} in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
        );

        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connect();
            } catch (e) {
                // connect() が reject した場合、close イベントで再度 attemptReconnect が呼ばれる
            }
        }, delay);
    }

    sendAudio(pcmBuffer: Buffer): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(pcmBuffer);
        }
    }

    disconnect(): void {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
    }
}
