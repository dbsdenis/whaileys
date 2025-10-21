import { Boom } from '@hapi/boom'
import makeWASocket, {
  AnyMessageContent,
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  MessageRetryMap,
  useMultiFileAuthState
} from '../src'
import MAIN_LOGGER from '../src/Utils/logger'

const logger = MAIN_LOGGER.child({})
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterMap: MessageRetryMap = {}

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
  store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// Variáveis para controle de reconexão
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5
const BASE_RECONNECT_DELAY = 1000 // 1 segundo

// start a connection
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
  // fetch latest version of WA Web
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

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
        const msg = await store.loadMessage(key.remoteJid!, key.id!)
        return msg?.message || undefined
      }

      // only if store is present
      return {
        conversation: 'hello'
      }
    }
  })

  store?.bind(sock.ev)

  const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
    await sock.presenceSubscribe(jid)
    await delay(500)

    await sock.sendPresenceUpdate('composing', jid)
    await delay(2000)

    await sock.sendPresenceUpdate('paused', jid)

    await sock.sendMessage(jid, msg)
  }

  // the process function lets you process all events that just occurred
  // efficiently in a batch
  sock.ev.process(
    // events is a map for event name => event data
    async events => {
      // something about the connection changed
      // maybe it closed, or we received all offline message or connection opened
      if (events['connection.update']) {
        const update = events['connection.update']
        const { connection, lastDisconnect } = update

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
          const isLoggedOut = statusCode === DisconnectReason.loggedOut

          console.log('connection update', {
            ...update,
            statusCode,
            isLoggedOut,
            reconnectAttempts
          })

          // Sempre tenta reconectar quando a conexão é fechada
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++
            // Backoff exponencial: 1s, 2s, 4s, 8s, 16s (máximo 30s)
            const delayMs = Math.min(
              BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1),
              30000
            )

            const reason = isLoggedOut ? 'Deslogado (401) - será necessário escanear QR code' : `Erro ${statusCode}`
            console.log(
              `${reason} - Reconectando em ${delayMs / 1000}s (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
            )

            setTimeout(() => {
              startSock()
            }, delayMs)
          } else {
            console.error(
              `Máximo de tentativas de reconexão atingido (${MAX_RECONNECT_ATTEMPTS}). Parando reconexões automáticas.`
            )
          }
        } else if (connection === 'open') {
          // Reset contador ao conectar com sucesso
          console.log('Conexão estabelecida com sucesso!')
          reconnectAttempts = 0
        }

        console.log('connection update', update)
      }

      // credentials updated -- save them
      if (events['creds.update']) {
        await saveCreds()
      }

      if (events.call) {
        console.log('recv call event', events.call)
      }

      // history received
      if (events['messaging-history.set']) {
        const { chats, contacts, messages, isLatest } =
          events['messaging-history.set']
        console.log(
          `recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`
        )
      }

      // received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (!msg.key.fromMe && doReplies) {
              console.log('replying to', msg.key.remoteJid)
              await sock!.readMessages([msg.key])
              await sendMessageWTyping(
                { text: 'Hello there!' },
                msg.key.remoteJid!
              )
            }
          }
        }
      }

      // messages updated like status delivered, message deleted etc.
      if (events['messages.update']) {
        console.log(events['messages.update'])
      }

      if (events['message-receipt.update']) {
        console.log(events['message-receipt.update'])
      }

      if (events['messages.reaction']) {
        console.log(events['messages.reaction'])
      }

      if (events['presence.update']) {
        console.log(events['presence.update'])
      }

      if (events['chats.update']) {
        console.log(events['chats.update'])
      }

      if (events['contacts.update']) {
        for (const contact of events['contacts.update']) {
          if (typeof contact.imgUrl !== 'undefined') {
            const newUrl =
              contact.imgUrl === null
                ? null
                : await sock!.profilePictureUrl(contact.id!)
            console.log(
              `contact ${contact.id} has a new profile pic: ${newUrl}`
            )
          }
        }
      }

      if (events['chats.delete']) {
        console.log('chats deleted ', events['chats.delete'])
      }
    }
  )

  return sock
}

startSock()
