import { Struct } from '@yume-chan/struct';
import { AdbBufferedStream, chunkArrayLike } from '../../stream';
import { AdbSyncRequestId, adbSyncWriteRequest } from './request';
import { adbSyncReadResponse, AdbSyncResponseId } from './response';
import { LinuxFileType } from './stat';

export const AdbSyncOkResponse =
    new Struct({ littleEndian: true })
        .uint32('unused');

const ResponseTypes = {
    [AdbSyncResponseId.Ok]: AdbSyncOkResponse,
};

export async function* chunkAsyncIterable(
    value: AsyncIterable<ArrayBuffer>,
    size: number
): AsyncGenerator<ArrayBuffer, void, void> {
    let result = new Uint8Array(size);
    let index = 0;
    for await (let buffer of value) {
        // `result` has some data, `result + buffer` is enough
        if (index !== 0 && index + buffer.byteLength >= size) {
            const remainder = size - index;
            result.set(new Uint8Array(buffer, 0, remainder), index);
            yield result.buffer;

            result = new Uint8Array(size);
            index = 0;

            if (buffer.byteLength > remainder) {
                // `buffer` still has some data
                buffer = buffer.slice(remainder);
            } else {
                continue;
            }
        }

        // `result` is empty, `buffer` alone is enough
        if (buffer.byteLength >= size) {
            let remainder = false;
            for (const chunk of chunkArrayLike(buffer, size)) {
                if (chunk.byteLength === size) {
                    yield chunk;
                    continue;
                }

                // `buffer` still has some data
                remainder = true;
                buffer = chunk;
            }

            if (!remainder) {
                continue;
            }
        }

        // `result` has some data but `result + buffer` is still not enough
        // or after previous steps `buffer` still has some data
        result.set(new Uint8Array(buffer), index);
        index += buffer.byteLength;
    }

    if (index !== 0) {
        yield result.buffer.slice(0, index);
    }
}

export const AdbSyncMaxPacketSize = 64 * 1024;

export async function adbSyncPush(
    stream: AdbBufferedStream,
    filename: string,
    content: ArrayLike<number> | ArrayBufferLike | AsyncIterable<ArrayBuffer>,
    mode: number = (LinuxFileType.File << 12) | 0o666,
    mtime: number = (Date.now() / 1000) | 0,
    packetSize: number = AdbSyncMaxPacketSize,
    onProgress?: (uploaded: number) => void,
): Promise<void> {
    const pathAndMode = `${filename},${mode.toString()}`;
    await adbSyncWriteRequest(stream, AdbSyncRequestId.Send, pathAndMode);

    let chunkReader: Iterable<ArrayBuffer> | AsyncIterable<ArrayBuffer>;
    if ('length' in content || 'byteLength' in content) {
        chunkReader = chunkArrayLike(content, packetSize);
    } else {
        chunkReader = chunkAsyncIterable(content, packetSize);
    }

    let uploaded = 0;
    for await (const buffer of chunkReader) {
        await adbSyncWriteRequest(stream, AdbSyncRequestId.Data, buffer);
        uploaded += buffer.byteLength;
        onProgress?.(uploaded);
    }

    await adbSyncWriteRequest(stream, AdbSyncRequestId.Done, mtime);
    await adbSyncReadResponse(stream, ResponseTypes);
}
