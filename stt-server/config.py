from dataclasses import dataclass


@dataclass
class STTConfig:
    model_name: str = "kotoba-tech/kotoba-whisper-v2.0-faster"
    device: str = "cuda"
    compute_type: str = "int8"  # int8 で VRAM ~1.5GB
    language: str = "ja"
    beam_size: int = 5
    vad_threshold: float = 0.5
    # 発話の最小・最大長（秒）
    min_speech_duration: float = 0.5
    max_speech_duration: float = 30.0
    # 無音がこの秒数続いたら発話終了とみなす
    silence_duration: float = 0.8
    # WebSocket サーバー
    host: str = "127.0.0.1"
    port: int = 8765
    # 入力音声フォーマット（Node.jsから送られてくるPCM）
    sample_rate: int = 16000  # Node.js側でリサンプル済み
    channels: int = 1
