import asyncio
import json
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn
from config import STTConfig
from transcriber import Transcriber
from vad import SileroVAD

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config = STTConfig()
app = FastAPI()
transcriber = Transcriber(config)

# 接続ごとのVADインスタンスを管理
vad_instances: dict[str, SileroVAD] = {}


@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await websocket.accept()
    logger.info(f"Connected: {user_id}")

    vad = SileroVAD(
        threshold=config.vad_threshold,
        sample_rate=config.sample_rate,
        silence_duration=config.silence_duration,
        min_speech_duration=config.min_speech_duration,
    )
    vad_instances[user_id] = vad

    try:
        while True:
            # Node.jsから16kHz 16bit mono PCMバイナリが送られてくる
            data = await websocket.receive_bytes()

            # VADで発話区間を検出
            completed = vad.process_chunk(data)

            for utterance_pcm in completed:
                # 発話が完了したら推論キューに入れる
                text = await transcriber.transcribe(utterance_pcm)
                if text:
                    await websocket.send_text(
                        json.dumps(
                            {
                                "user_id": user_id,
                                "text": text,
                            }
                        )
                    )
                    logger.info(f"[{user_id}] {text}")

    except WebSocketDisconnect:
        logger.info(f"Disconnected: {user_id}")
    except Exception as e:
        logger.error(f"Error for {user_id}: {e}")
    finally:
        vad.reset()
        if user_id in vad_instances:
            del vad_instances[user_id]


@app.get("/health")
async def health():
    return {"status": "ok", "active_connections": len(vad_instances)}


if __name__ == "__main__":
    uvicorn.run(app, host=config.host, port=config.port)
