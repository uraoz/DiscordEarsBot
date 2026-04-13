from faster_whisper import WhisperModel
import numpy as np
import asyncio
from concurrent.futures import ThreadPoolExecutor
from config import STTConfig


class Transcriber:
    def __init__(self, config: STTConfig):
        self.config = config
        self.model = WhisperModel(
            config.model_name,
            device=config.device,
            compute_type=config.compute_type,
        )
        # GPU推論はシングルスレッドでシリアライズする
        # faster-whisperのCTranslate2はGPU並列不可
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._lock = asyncio.Lock()

    def _transcribe_sync(self, audio: np.ndarray) -> str:
        """同期的に推論を実行（ThreadPoolExecutor内で呼ばれる）"""
        segments, info = self.model.transcribe(
            audio,
            language=self.config.language,
            beam_size=self.config.beam_size,
            vad_filter=False,  # 外部VADを使うのでここではOFF
            without_timestamps=True,
        )
        text = "".join(segment.text for segment in segments).strip()
        return text

    async def transcribe(self, pcm_bytes: bytes) -> str:
        """
        16kHz 16bit mono PCM bytes → テキスト
        GPU推論はロックで排他制御する
        """
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        async with self._lock:
            loop = asyncio.get_event_loop()
            text = await loop.run_in_executor(
                self._executor, self._transcribe_sync, audio
            )
        return text
