const { Boom } = require('@hapi/boom');
const { readdir, unlink } = require('fs/promises');
const { join } = require('path');
const makeWASocket = require('../lib').default;
const {
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  useMultiFileAuthState
} = require('../lib');
const MAIN_LOGGER = require('../lib/Utils/logger').default;

const logger = MAIN_LOGGER.child({});
logger.level = 'trace';

const useStore = !process.argv.includes('--no-store');
const doReplies = !process.argv.includes('--no-reply');

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterMap = {};

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined;
store?.readFromFile('./baileys_store_multi.json');
// save every 10s
setInterval(() => {
  store?.writeToFile('./baileys_store_multi.json');
}, 10_000);

// Variáveis para controle de reconexão
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 1000; // 1 segundo
const AUTH_FOLDER = 'baileys_auth_info';

/**
 * Limpa todas as credenciais de autenticação
 * Usado quando o usuário é deslogado (401)
 */
const clearAuthFolder = async () => {
  try {
    const files = await readdir(AUTH_FOLDER);
    const deletePromises = files.map(file => unlink(join(AUTH_FOLDER, file)));
    await Promise.all(deletePromises);
    logger.info('Credenciais antigas removidas. Nova sessão será criada.');
  } catch (error) {
    logger.error('Não foi possível limpar credenciais:', error);
  }
};

// start a connection
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  // fetch latest version of WA Web
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      /** caching makes the store faster to send/recv messages */
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    msgRetryCounterMap,
    generateHighQualityLinkPreview: true,
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
    // implement to handle retries
    getMessage: async key => {
      if (store) {
        const msg = await store.loadMessage(key.remoteJid, key.id);
        return msg?.message || undefined;
      }

      // only if store is present
      return {
        conversation: 'hello'
      };
    }
  });

  store?.bind(sock.ev);

  const sendMessageWTyping = async (msg, jid) => {
    await sock.presenceSubscribe(jid);
    await delay(500);

    await sock.sendPresenceUpdate('composing', jid);
    await delay(2000);

    await sock.sendPresenceUpdate('paused', jid);

    await sock.sendMessage(jid, msg);
  };

  // the process function lets you process all events that just occurred
  // efficiently in a batch
  sock.ev.process(
    // events is a map for event name => event data
    async events => {
      // something about the connection changed
      // maybe it closed, or we received all offline message or connection opened
      if (events['connection.update']) {
        const update = events['connection.update'];
        const { connection, lastDisconnect, isNewLogin } = update;

        // Reset contador quando login bem-sucedido (após pair-success)
        // O erro 515 após pair-success é esperado e deve reconectar rapidamente
        if (isNewLogin) {
          logger.info('Login bem-sucedido! Resetando contador de reconexão.');
          reconnectAttempts = 0;
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          logger.info('connection update', {
            ...update,
            statusCode,
            isLoggedOut,
            reconnectAttempts
          });

          // Sempre tenta reconectar quando a conexão é fechada
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            // Backoff exponencial: 1s, 2s, 4s, 8s, 16s (máximo 30s)
            const delayMs = Math.min(
              BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1),
              30000
            );

            const reason = isLoggedOut
              ? 'Deslogado (401) - Criando nova sessão com QR code'
              : `Erro ${statusCode}`;
            logger.info(
              `${reason} - Reconectando em ${delayMs / 1000}s (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
            );

            setTimeout(async () => {
              // Se foi logout, limpa credenciais antigas antes de reconectar
              if (isLoggedOut) {
                await clearAuthFolder();
              }
              startSock();
            }, delayMs);
          } else {
            logger.error(
              `Máximo de tentativas de reconexão atingido (${MAX_RECONNECT_ATTEMPTS}). Parando reconexões automáticas.`
            );
          }
        } else if (connection === 'open') {
          // Reset contador ao conectar com sucesso
          logger.info('Conexão estabelecida com sucesso!');
          reconnectAttempts = 0;
        }

        logger.debug('connection update', update);
      }

      // credentials updated -- save them
      if (events['creds.update']) {
        await saveCreds();
      }

      if (events.call) {
        logger.info('recv call event', events.call);
      }

      // history received
      if (events['messaging-history.set']) {
        const { chats, contacts, messages, isLatest } =
          events['messaging-history.set'];
        logger.info(
          `recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`
        );
      }

      // received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert'];
        logger.debug('recv messages ', JSON.stringify(upsert, undefined, 2));

        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (!msg.key.fromMe && doReplies) {
              logger.info('replying to', msg.key.remoteJid);
              await sock.readMessages([msg.key]);
              await sendMessageWTyping(
                { text: 'Hello there!' },
                msg.key.remoteJid
              );
            }
          }
        }
      }

      // messages updated like status delivered, message deleted etc.
      if (events['messages.update']) {
        logger.debug(events['messages.update']);
      }

      if (events['message-receipt.update']) {
        logger.debug(events['message-receipt.update']);
      }

      if (events['messages.reaction']) {
        logger.debug(events['messages.reaction']);
      }

      if (events['presence.update']) {
        logger.debug(events['presence.update']);
      }

      if (events['chats.update']) {
        logger.debug(events['chats.update']);
      }

      if (events['contacts.update']) {
        for (const contact of events['contacts.update']) {
          if (typeof contact.imgUrl !== 'undefined') {
            const newUrl =
              contact.imgUrl === null
                ? null
                : await sock.profilePictureUrl(contact.id);
            logger.info(
              `contact ${contact.id} has a new profile pic: ${newUrl}`
            );
          }
        }
      }

      if (events['chats.delete']) {
        logger.info('chats deleted ', events['chats.delete']);
      }
    }
  );

  return sock;
};

startSock();
