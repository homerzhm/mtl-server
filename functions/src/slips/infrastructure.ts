import {randomUUID} from 'node:crypto';
import {Dispatch} from './database';
import {GoogleRequest, RemoteFailure, readJson} from './transport';

export interface SlipStorage {
  save(key: string, photo: Buffer, hash: string): Promise<string>;
  read(key: string, generation: string, signal?: AbortSignal): Promise<Buffer>;
  remove(key: string, generation: string): Promise<void>;
}

const deadline = () => AbortSignal.timeout(8000);

export function bucketStorage(bucket: string, request: GoogleRequest): SlipStorage {
  const resource = `https://storage.googleapis.com/storage/v1/b/${bucket}/o`;
  const objectUrl = (key: string) => `${resource}/${encodeURIComponent(key)}`;
  return {
    async save(key, photo, hash) {
      const boundary = randomUUID();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
          JSON.stringify({name: key, contentType: 'image/jpeg', metadata: {checksum: hash}}) +
          `\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
        photo, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const uploaded = await request(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=multipart&ifGenerationMatch=0`, {
        method: 'POST', headers: {'Content-Type': `multipart/related; boundary=${boundary}`},
        body: new Uint8Array(body), signal: deadline(),
      });
      const response = uploaded.status === 412
        ? await (async () => {
          await uploaded.body?.cancel();
          return request(objectUrl(key), {signal: deadline()});
        })()
        : uploaded;
      const object = await readJson(response) as {generation?: string; metadata?: {checksum?: string}};
      if (object.metadata?.checksum !== hash) throw new PhotoConflict();
      if (!object.generation || !/^\d+$/.test(object.generation)) throw new Error('Missing slip photo generation');
      return object.generation;
    },
    async read(key, generation, signal) {
      const response = await request(`${objectUrl(key)}?alt=media&generation=${generation}`, {signal: signal ?? deadline()});
      if (!response.ok) {
        await response.body?.cancel();
        throw new RemoteFailure(response.status);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async remove(key, generation) {
      const response = await request(`${objectUrl(key)}?generation=${generation}&ifGenerationMatch=${generation}`, {
        method: 'DELETE', signal: deadline(),
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new RemoteFailure(response.status);
    },
  };
}

export class PhotoConflict extends Error {
  constructor() { super('Slip photo conflicts with previous upload'); }
}

export function taskQueue(project: string, region: string, invoker: string, request: GoogleRequest) {
  const parent = `projects/${project}/locations/${region}/queues/processOrderSlipTask`;
  const url = `https://${region}-${project}.cloudfunctions.net/processOrderSlipTask`;
  return async (task: Dispatch) => {
    const body = Buffer.from(JSON.stringify({data: {taskId: task.id, generation: task.dispatch_generation}})).toString('base64');
    const response = await request(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
      method: 'POST', signal: deadline(),
      body: JSON.stringify({task: {
        name: `${parent}/tasks/${task.id}-${task.dispatch_generation}`,
        dispatchDeadline: '140s',
        httpRequest: {httpMethod: 'POST', url, oidcToken: {serviceAccountEmail: invoker, audience: url},
          headers: {'Content-Type': 'application/json'}, body},
      }}),
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 409) throw new RemoteFailure(response.status);
  };
}
