/**
 * @deprecated This module is a stub. AMI/ARI events are handled by:
 * - ari-stasis-queue.js (ARI WebSocket for queue routing)
 * - routes/asterisk.js (HTTP callbacks from Asterisk dialplan)
 * This file is kept for backwards compatibility but does nothing.
 */
export default function initAsteriskEvents() {
  // No-op: events handled elsewhere
}
