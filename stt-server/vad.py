import torch
import numpy as np


class SileroVAD:
    def __init__(
        self,
        threshold: float = 0.5,
        sample_rate: int = 16000,
        silence_duration: float = 0.8,
        min_speech_duration: float = 0.5,
    ):
        self.model, self.utils = torch.hub.load(
            "snakers4/silero-vad", "silero_vad"
        )
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.silence_samples = int(silence_duration * sample_rate)
        self.min_speech_samples = int(min_speech_duration * sample_rate)

        # 状態管理
        self.is_speaking = False
        self.speech_buffer = bytearray()
        self.silence_counter = 0

    def reset(self):
        """接続リセット時に呼ぶ"""
        self.model.reset_states()
        self.is_speaking = False
        self.speech_buffer = bytearray()
        self.silence_counter = 0

    def process_chunk(self, pcm_bytes: bytes) -> list[bytes]:
        """
        16kHz 16bit mono PCM チャンクを受け取り、
        完了した発話（PCM bytes）のリストを返す。
        通常は0個か1個。
        """
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        tensor = torch.from_numpy(audio)

        # Silero VAD は 512 サンプル（16kHz で 32ms）単位で処理
        completed_utterances: list[bytes] = []
        chunk_size = 512
        for i in range(0, len(tensor), chunk_size):
            frame = tensor[i : i + chunk_size]
            if len(frame) < chunk_size:
                frame = torch.nn.functional.pad(frame, (0, chunk_size - len(frame)))

            prob = self.model(frame, self.sample_rate).item()

            if prob >= self.threshold:
                self.is_speaking = True
                self.silence_counter = 0
                # 元のint16 PCMデータを保持
                start_byte = i * 2
                end_byte = min((i + chunk_size) * 2, len(pcm_bytes))
                self.speech_buffer.extend(pcm_bytes[start_byte:end_byte])
            else:
                if self.is_speaking:
                    self.silence_counter += chunk_size
                    # 無音部分もバッファに含める（文脈保持）
                    start_byte = i * 2
                    end_byte = min((i + chunk_size) * 2, len(pcm_bytes))
                    self.speech_buffer.extend(pcm_bytes[start_byte:end_byte])

                    if self.silence_counter >= self.silence_samples:
                        # 発話終了
                        if len(self.speech_buffer) >= self.min_speech_samples * 2:
                            completed_utterances.append(bytes(self.speech_buffer))
                        self.speech_buffer = bytearray()
                        self.is_speaking = False
                        self.silence_counter = 0

        return completed_utterances
