import { Transform, TransformCallback } from "stream";

/**
 * 48kHz stereo 16bit PCM → 16kHz mono 16bit PCM に変換する Transform stream。
 *
 * 手順:
 * 1. stereo → mono: 左右チャンネルの平均を取る
 * 2. 48kHz → 16kHz: 3サンプルに1つ取る（48000/16000 = 3）
 *
 * 注意: 単純間引きはエイリアシングが発生するが、
 * 音声認識用途では実用上問題ない。
 */
export class ResampleTransform extends Transform {
    private remainder: Buffer = Buffer.alloc(0);

    _transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
        // 前回の余りと結合
        const input = Buffer.concat([this.remainder, chunk]);

        // 1サンプル = 2ch * 2bytes = 4bytes、3サンプル間引き = 12bytes単位
        const frameSize = 12; // 4bytes * 3 (decimation factor)
        const usableLength = Math.floor(input.length / frameSize) * frameSize;
        this.remainder = input.subarray(usableLength);

        const outputSamples = Math.floor(usableLength / frameSize);
        if (outputSamples === 0) {
            callback();
            return;
        }

        const output = Buffer.alloc(outputSamples * 2); // mono 2bytes per sample

        for (let i = 0; i < outputSamples; i++) {
            const byteOffset = i * frameSize; // 3サンプル分のオフセット
            const left = input.readInt16LE(byteOffset);
            const right = input.readInt16LE(byteOffset + 2);
            const mono = Math.round((left + right) / 2);
            output.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * 2);
        }

        this.push(output);
        callback();
    }

    _flush(callback: TransformCallback) {
        // 残余データがあれば処理
        if (this.remainder.length >= 4) {
            const left = this.remainder.readInt16LE(0);
            const right = this.remainder.readInt16LE(2);
            const mono = Math.round((left + right) / 2);
            const output = Buffer.alloc(2);
            output.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), 0);
            this.push(output);
        }
        callback();
    }
}
