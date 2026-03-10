/**
 * Asterisk event subscription (AMI/ARI). Optional Phase 3 extension.
 * When configured, can connect to AMI or ARI WebSocket and push events into call-handler.
 * For now we rely on dialplan HTTP callbacks (IncomingCall, CallAnswered, CallHangup).
 */
export function startAsteriskEvents() {
  // Future: connect to AMI or ARI, subscribe to channel/bridge events, call call-handler.
  if (process.env.ASTERISK_AMI_HOST || process.env.ASTERISK_ARI_WS) {
    console.log('[asterisk-events] AMI/ARI WebSocket not yet implemented; using HTTP callbacks.');
  }
}
