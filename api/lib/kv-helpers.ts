export const getServerCursor = (env: Env, serverName: string) =>
  env.GMAIL_HISTORY_KV.get(`cursor:${serverName}`);

export const putServerCursor = (
  env: Env,
  serverName: string,
  historyId: string
) =>
  env.GMAIL_HISTORY_KV.put(
    `cursor:${serverName}`,
    historyId /*, { expirationTtl: 60*60*24*90 }*/
  );
