/**
 * Destroy all server sessions for a given user id (e.g. when force-logout from live monitoring).
 * Store must support .all(callback) and .destroy(sid, callback) (e.g. MemoryStore).
 */
export function destroySessionsForUser(store, userId, callback) {
  if (!store || typeof store.all !== 'function') {
    return callback && callback(null);
  }
  store.all((err, sessions) => {
    if (err) return callback && callback(err);
    const sids = Object.keys(sessions || {}).filter(
      (sid) => sessions[sid]?.user?.id === userId
    );
    if (sids.length === 0) return callback && callback(null);
    let done = 0;
    sids.forEach((sid) => {
      store.destroy(sid, () => {
        done++;
        if (done === sids.length) callback && callback(null);
      });
    });
  });
}
