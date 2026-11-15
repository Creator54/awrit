import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import {
  FeedbackDeliveryTracker,
  type FeedbackSocket,
  type FeedbackPayload,
} from './feedbackDelivery';

class MockFeedbackSocket implements FeedbackSocket {
  destroyed = false;
  written: string[] = [];
  writeError: Error | null = null;
  deferCallback = false;
  pendingCallbacks: Array<(error?: Error | null) => void> = [];

  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed) {
      if (callback) callback(new Error('Socket is destroyed'));
      return false;
    }
    this.written.push(data);
    if (callback) {
      if (this.deferCallback) {
        this.pendingCallbacks.push(callback);
      } else {
        callback(this.writeError);
      }
    }
    return true;
  }

  flushCallbacks(): void {
    const cbs = [...this.pendingCallbacks];
    this.pendingCallbacks = [];
    for (const cb of cbs) {
      cb(this.writeError);
    }
  }
}

describe('FeedbackDeliveryTracker', () => {
  test('exactack: settles with { ok: true } when acked on the matching socket', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket = new MockFeedbackSocket();
    const payload: FeedbackPayload = { draftId: 'draft-1', summary: 'Check header' };

    const promise = tracker.send(socket, payload);
    expect(tracker.getPendingCount()).toBe(1);
    expect(tracker.hasPending(socket, 'draft-1')).toBe(true);
    expect(socket.written.length).toBe(1);

    const message = JSON.parse(socket.written[0]);
    expect(message).toEqual({
      event: 'design:send-feedback',
      draftId: 'draft-1',
      summary: 'Check header',
    });

    const acked = tracker.ack(socket, 'draft-1', true);
    expect(acked).toBe(true);

    const res = await promise;
    expect(res).toEqual({ ok: true });
    expect(tracker.getPendingCount()).toBe(0);
    expect(tracker.hasPending(socket, 'draft-1')).toBe(false);
  });

  test('foreignack: ack on a different socket does not settle pending request', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket1 = new MockFeedbackSocket();
    const socket2 = new MockFeedbackSocket();

    const promise = tracker.send(socket1, { draftId: 'draft-shared', text: 'hi' });

    // socket2 tries to ACK socket1's draft
    const foreignAcked = tracker.ack(socket2, 'draft-shared', true);
    expect(foreignAcked).toBe(false);
    expect(tracker.hasPending(socket1, 'draft-shared')).toBe(true);
    expect(tracker.getPendingCount()).toBe(1);

    // Matching socket ACKs
    const correctAcked = tracker.ack(socket1, 'draft-shared', true);
    expect(correctAcked).toBe(true);

    const res = await promise;
    expect(res).toEqual({ ok: true });
    expect(tracker.getPendingCount()).toBe(0);
  });

  test('negative: ack with false settles with { ok: false, error }', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket = new MockFeedbackSocket();

    const promise = tracker.send(socket, { draftId: 'draft-rejected' });
    const acked = tracker.ack(socket, 'draft-rejected', false, 'Agent declined feedback');
    expect(acked).toBe(true);

    const res = await promise;
    expect(res).toEqual({ ok: false, error: 'Agent declined feedback' });
    expect(tracker.getPendingCount()).toBe(0);
  });

  test('negative: ack with false defaults error message when not specified', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket = new MockFeedbackSocket();

    const promise = tracker.send(socket, { draftId: 'draft-rejected-default' });
    tracker.ack(socket, 'draft-rejected-default', false);

    const res = await promise;
    expect(res).toEqual({ ok: false, error: 'Feedback rejected' });
  });

  test('timeout: settles with "Feedback acceptance not confirmed; outcome unknown" without retry', async () => {
    const timeoutMs = 20;
    const tracker = new FeedbackDeliveryTracker(timeoutMs);
    const socket = new MockFeedbackSocket();

    const promise = tracker.send(socket, { draftId: 'draft-timeout' });
    const res = await promise;

    expect(res).toEqual({
      ok: false,
      error: 'Feedback acceptance not confirmed; outcome unknown',
    });
    expect(tracker.getPendingCount()).toBe(0);
    expect(tracker.hasPending(socket, 'draft-timeout')).toBe(false);
    // Ensure no duplicate retry write was triggered
    expect(socket.written.length).toBe(1);
  });

  test('disconnect: settles all pending on that socket with uncertain outcome', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket = new MockFeedbackSocket();

    const p1 = tracker.send(socket, { draftId: 'd1' });
    const p2 = tracker.send(socket, { draftId: 'd2' });
    expect(tracker.getPendingCount()).toBe(2);

    const settledCount = tracker.disconnect(socket);
    expect(settledCount).toBe(2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({
      ok: false,
      error: 'Feedback acceptance not confirmed; outcome unknown',
    });
    expect(r2).toEqual({
      ok: false,
      error: 'Feedback acceptance not confirmed; outcome unknown',
    });
    expect(tracker.getPendingCount()).toBe(0);
  });

  test('samependingduplicate: outstanding duplicate returns same promise and avoids second write', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket = new MockFeedbackSocket();

    const p1 = tracker.send(socket, { draftId: 'd-dup', payload: 'first' });
    const p2 = tracker.send(socket, { draftId: 'd-dup', payload: 'second' });

    expect(p1).toBe(p2);
    expect(socket.written.length).toBe(1);
    expect(tracker.getPendingCount()).toBe(1);

    tracker.ack(socket, 'd-dup', true);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
  });

  test('cap: immediate error on exceeding pending limit without writing', async () => {
    const tracker = new FeedbackDeliveryTracker(1000, 2);
    const socket = new MockFeedbackSocket();

    const p1 = tracker.send(socket, { draftId: 'c1' });
    const p2 = tracker.send(socket, { draftId: 'c2' });
    expect(tracker.getPendingCount()).toBe(2);
    expect(socket.written.length).toBe(2);

    // 3rd attempt exceeds cap of 2
    const p3 = tracker.send(socket, { draftId: 'c3' });
    const r3 = await p3;
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error).toMatch(/cap|limit|full/i);
    }
    // Socket was not written to for c3
    expect(socket.written.length).toBe(2);
    expect(tracker.hasPending(socket, 'c3')).toBe(false);

    // Settle one
    tracker.ack(socket, 'c1', true);
    await p1;
    expect(tracker.getPendingCount()).toBe(1);

    // Now c4 can proceed
    const p4 = tracker.send(socket, { draftId: 'c4' });
    expect(socket.written.length).toBe(3);
    tracker.ack(socket, 'c4', true);
    await p4;
    tracker.ack(socket, 'c2', true);
    await p2;
    expect(tracker.getPendingCount()).toBe(0);
  });

  test('writefailure: write callback error settles pending immediately', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket = new MockFeedbackSocket();
    socket.writeError = new Error('EPIPE connection broken');

    const promise = tracker.send(socket, { draftId: 'd-err' });
    const res = await promise;

    expect(res).toEqual({ ok: false, error: 'EPIPE connection broken' });
    expect(tracker.getPendingCount()).toBe(0);
    expect(tracker.hasPending(socket, 'd-err')).toBe(false);
  });

  test('writecallback race: stale write callback error after timeout does not reject newer request for same draftId', async () => {
    const tracker = new FeedbackDeliveryTracker(20);
    const socket = new MockFeedbackSocket();
    socket.deferCallback = true;

    const p1 = tracker.send(socket, { draftId: 'draft-race', seq: 1 });
    expect(socket.pendingCallbacks.length).toBe(1);
    const firstCb = socket.pendingCallbacks[0];

    const res1 = await p1;
    expect(res1).toEqual({
      ok: false,
      error: 'Feedback acceptance not confirmed; outcome unknown',
    });
    expect(tracker.hasPending(socket, 'draft-race')).toBe(false);

    const p2 = tracker.send(socket, { draftId: 'draft-race', seq: 2 });
    expect(tracker.hasPending(socket, 'draft-race')).toBe(true);

    firstCb(new Error('Stale write failure'));
    expect(tracker.hasPending(socket, 'draft-race')).toBe(true);

    const acked = tracker.ack(socket, 'draft-race', true);
    expect(acked).toBe(true);

    const res2 = await p2;
    expect(res2).toEqual({ ok: true });
    expect(tracker.hasPending(socket, 'draft-race')).toBe(false);
    expect(tracker.getPendingCount()).toBe(0);
  });

  test('net.Socket is assignable to FeedbackSocket without casts', () => {
    const realSocket = new net.Socket();
    const typedSocket: FeedbackSocket = realSocket;
    expect(typeof typedSocket.write).toBe('function');
    expect(typeof typedSocket.destroyed).toBe('boolean');
    realSocket.destroy();
  });

  test('dispose: cleans up all pending timers and maps', async () => {
    const tracker = new FeedbackDeliveryTracker(5000);
    const socket1 = new MockFeedbackSocket();
    const socket2 = new MockFeedbackSocket();

    const p1 = tracker.send(socket1, { draftId: 'disp1' });
    const p2 = tracker.send(socket2, { draftId: 'disp2' });
    expect(tracker.getPendingCount()).toBe(2);

    tracker.dispose();
    expect(tracker.getPendingCount()).toBe(0);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  test('serialization: BigInt in payload rejects safely with getPendingCount 0', async () => {
    const tracker = new FeedbackDeliveryTracker(1000);
    const socket = new MockFeedbackSocket();
    const payload: any = { draftId: 'draft-bigint', value: BigInt(9007199254740991) };

    const res = await tracker.send(socket, payload);
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(tracker.getPendingCount()).toBe(0);
  });
});
