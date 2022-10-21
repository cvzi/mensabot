/* globals addEventListener, Event, Response, fetch, MENSA_HTTP_CACHE, MENSA_SUBSCRIPTIONS, MENSA_STATUS */
const TOKEN = '123456789:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const WEBHOOK = '/webhook'
const SECRET = 'BlisterInTheSun' // A-Z, a-z, 0-9, _ and -

const foodEmoji = {
  '🥥': ['kokos', 'cocos']
  // ..
}

const shortNames = {
  279: 'HDi'
  // ...
}

const fetchConfig = {
  cf: {
    // Always cache this fetch regardless of content type
    // for a max of 10min before revalidating the resource
    cacheTtl: 10 * 60,
    cacheEverything: true
  }
}

async function cachedFetchJSON (url, fetchConfig, event, expire = 1800) {
  url = url.toString()

  let data = await MENSA_HTTP_CACHE.get(url, { type: 'json' })
  if (!data) {
    const resp = await fetch(url, fetchConfig)
    let text = 'null'
    if (resp.ok) {
      text = await resp.text()
    }
    if (event instanceof Event) {
      event.waitUntil(MENSA_HTTP_CACHE.put(url, text, { expirationTtl: expire }))
    } else {
      await MENSA_HTTP_CACHE.put(url, text, { expirationTtl: expire })
    }
    data = JSON.parse(text)
  } else {
    console.log('Cache hit: ' + url)
  }
  return data
}

async function cachedMultiPageJSON (url, fetchConfig, event, expire = 1800) {
  let page = 1
  let data = await MENSA_HTTP_CACHE.get(url, { type: 'json' })
  if (!data) {
    data = []
    const addr = new URL(url)
    let resp = null
    while (page === 1 || (resp.headers.has('X-Total-Pages') && resp.headers.has('X-Current-Page') && parseInt(resp.headers.get('X-Current-Page')) < parseInt(resp.headers.get('X-Total-Pages')))) {
      addr.searchParams.set('page', page)
      resp = await fetch(addr.toString(), fetchConfig)
      if (resp.ok) {
        data.push(...await resp.json())
        if (resp.headers.has('X-Current-Page')) {
          page = parseInt(resp.headers.get('X-Current-Page')) + 1
        }
      }
      if (page < 2 || !resp.ok) {
        break
      }
    }
    if (event instanceof Event) {
      event.waitUntil(MENSA_HTTP_CACHE.put(url, JSON.stringify(data), { expirationTtl: expire }))
    } else {
      await MENSA_HTTP_CACHE.put(url, JSON.stringify(data), { expirationTtl: expire })
    }
  } else {
    console.log('Cache hit: ' + url)
  }
  return data
}

function addFoodEmoji (text) {
  return text.split('\n').map(line => {
    for (const emoji in foodEmoji) {
      for (const pattern of foodEmoji[emoji]) {
        const re = new RegExp(pattern, 'gmi')
        const arr = re.exec(line)
        if (arr !== null) {
          let whitespaceStart = line.substring(re.lastIndex).search(/\s/)
          if (whitespaceStart === -1) {
            whitespaceStart = line.length
          } else {
            whitespaceStart += re.lastIndex
          }
          line = line.substring(0, whitespaceStart) + ` ${emoji} ` + line.substring(whitespaceStart)
        }
      }
    }
    return line
  }).join('\n')
}

function formatMeals (meals, date, canteen, config) {
  const defaultConfig = {
    showEnablePushLink: false,
    showDisablePushLink: false
  }
  config = Object.assign(defaultConfig, config || {})

  const categories = new Set(meals.map(meal => meal.category))

  let title = date ? escapeMarkdown(date.toLocaleDateString('de-DE')) : ''
  title += ` /${getCanteenIdentifier(canteen.id)}\n`
  title += canteen && 'name' in canteen ? `*${escapeMarkdown(canteen.name)}*` : ''
  if (title.trim()) {
    title = title.trim() + '\n'
  } else {
    title = null
  }

  const lines = [title]
  for (const category of categories) {
    lines.push(`*${escapeMarkdown(category)}*`)
    lines.push(...meals.filter(meal => meal.category === category).map(meal => {
      let line = escapeMarkdown(addFoodEmoji(meal.name))
      if (meal.notes) {
        let notes = meal.notes.join(', ').trim()
        if (notes) {
          notes = `(${addFoodEmoji(notes)})`
          line += ` ||${escapeMarkdown(notes)}||`
        }
      }
      return line
    }))
    lines.push('')
  }

  if (config.showEnablePushLink) {
    lines.push(`\nSubscribe to this canteen to receive the menu every morning /push${getCanteenIdentifier(canteen.id)}`)
  }
  if (config.showDisablePushLink) {
    lines.push(`\nUnsubscribe: /stop${getCanteenIdentifier(canteen.id)}`)
  }

  return lines.filter(line => line != null).join('\n').trim()
}

async function menuMessage (canteen, config, event = null) {
  const day = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
  if (day.getHours() > 17) {
    day.setDate(day.getDate() + 1)
  }
  const dateStr = day.toLocaleDateString('sv')
  const meals = await cachedFetchJSON(`https://openmensa.org/api/v2/canteens/${canteen.id}/days/${dateStr}/meals`, fetchConfig, event, 60 * 10)
  let text
  if (meals && meals.length) {
    text = formatMeals(meals, day, canteen, config)
  } else {
    text = 'No menu found'
  }
  return {
    text,
    meals
  }
}

function escapeMarkdown (str) {
  return str.replace(/[_*[\]()~`>#+\-=|{}.!]/gim, '\\$&')
}

function isShortName (text) {
  text = text.toLowerCase().trim()
  while (text.startsWith('/')) {
    text = text.substring(1).trim()
  }
  if (!text) {
    return null
  }

  for (const cid in shortNames) {
    if (shortNames[cid].toLowerCase() === text) {
      return parseInt(cid)
    }
  }

  return null
}

async function enablePushFor (chatId, canteen) {
  let data = await MENSA_SUBSCRIPTIONS.get(chatId, { type: 'json' })
  if (data == null) {
    data = {
      chatId,
      canteenIds: [canteen.id]
    }
  } else {
    data.canteenIds = new Set(data.canteenIds)
    data.canteenIds.add(canteen.id)
    data.canteenIds = Array.from(data.canteenIds)
  }
  return MENSA_SUBSCRIPTIONS.put(chatId, JSON.stringify(data))
}

async function disablePushFor (chatId, canteen) {
  const data = await MENSA_SUBSCRIPTIONS.get(chatId, { type: 'json' })
  if (data != null && data.canteenIds.length > 0) {
    data.canteenIds = data.canteenIds.filter(canteenId => canteenId !== canteen.id)
    return MENSA_SUBSCRIPTIONS.put(chatId, JSON.stringify(data))
  }
  return true
}

async function disablePush (chatId) {
  return MENSA_SUBSCRIPTIONS.delete(chatId)
}

async function sendPushMenu (canteenId, chatId) {
  const result = await menuMessage({ id: canteenId }, { showEnablePushLink: false, showDisablePushLink: true })
  if (result.meals && result.meals.length) {
    await sendPlainText(chatId, result.text, 'MarkdownV2')
  }
}

async function sendAllPush () {
  try {
    const allEntries = await MENSA_SUBSCRIPTIONS.list()
    console.log(allEntries.keys)

    let reqCounter = 0
    let sent = {}
    // Find out which messages were already sent today
    const status = await MENSA_STATUS.get('pushStatus', { type: 'json' }) // {date: new Date().toDateString(), sent: {chatId0: [canteenId0, ...]}, done: false}
    if (status && 'date' in status && new Date().toDateString() === status.date) {
      if (status.done) {
        console.log('sendAllPush() is already done for ' + status.date)
        return
      } else {
        sent = status.sent
      }
    }

    // Send messages
    let stopped = false
    for (let i = 0; i < allEntries.keys.length; i++) {
      const chatId = allEntries.keys[i].name
      const data = await MENSA_SUBSCRIPTIONS.get(chatId, { type: 'json' })
      console.log(data)
      if (!(chatId in sent)) {
        sent[chatId] = []
      }
      if (data != null && data.canteenIds.length > 0) {
        for (let j = 0; j < data.canteenIds.length; j++) {
          const canteenId = data.canteenIds[j]
          if (sent[chatId].indexOf(canteenId) !== -1) {
            // Already sent today
            continue
          }
          await sendPushMenu(canteenId, data.chatId)
          reqCounter++
          sent[chatId].push(canteenId)
          console.log('reqCounter: ' + reqCounter)

          if (reqCounter > 20) {
            // The maximum number of subrequests is 50 per run:
            // every message could be one request to openmensa and one to telegram
            stopped = true
            break
          }
        }
      }
      if (stopped) {
        break
      }
    }
    // Store what was sent this time (and previous times today)
    if (stopped) {
      await MENSA_STATUS.put('pushStatus', JSON.stringify({ date: new Date().toDateString(), sent, done: false }))
    } else {
      await MENSA_STATUS.put('pushStatus', JSON.stringify({ date: new Date().toDateString(), sent: {}, done: true }))
    }
  } catch (e) {
    // Store any errors in the KV storage
    console.error(e)
    try {
      const errors = await MENSA_STATUS.get('pushErrors', { type: 'json' }) || {}
      errors[new Date().toISOString()] = e.toString()
      await MENSA_STATUS.put('pushErrors', JSON.stringify(errors))
    } catch (e) {
      console.error(e)
    }
  }
}

function getCanteenIdentifier (canteenId) {
  return `${canteenId in shortNames ? shortNames[canteenId] : ('x' + canteenId)}`
}

/**
 * Handle incoming Message
 * https://core.telegram.org/bots/api#message
 */
async function onMessage (event, message) {
  let selectedCanteenId = null
  let searchQuery = null
  let textClean = message.text.trim().toLowerCase()
  let foundEnablePush = false
  let foundDisablePush = false

  if (textClean === '/off') {
    await disablePush(message.chat.id)
    const resp = await sendPlainText(message.chat.id, 'All data deleted!')
    if (!resp || !resp.ok) {
      console.error(resp)
    }
    return resp
  } else if (textClean === '/about') {
    const resp = await sendPlainText(message.chat.id, 'This is a bot for openmensa.org.\nMore info at https://github.com/cvzi/mensabot')
    if (!resp || !resp.ok) {
      console.error(resp)
    }
    return resp
  } else if (textClean.startsWith('/push')) {
    textClean = textClean.match(/\/push(.+)/i)[1].trim()
    foundEnablePush = true
  } else if (textClean.startsWith('/stop')) {
    foundDisablePush = true
    textClean = textClean.substring('/stop'.length).trim()
  }

  selectedCanteenId = isShortName(textClean)
  if (!selectedCanteenId && textClean.startsWith('/x')) {
    selectedCanteenId = parseInt(textClean.substr(2))
    if (isNaN(selectedCanteenId)) {
      selectedCanteenId = null
    }
  }

  if (!selectedCanteenId) {
    searchQuery = textClean.replace(/^\/\s+/, '')
  }

  let filter = canteen => false
  if (selectedCanteenId) {
    selectedCanteenId = parseInt(selectedCanteenId)
    filter = canteen => canteen.id === selectedCanteenId
  } else if (searchQuery) {
    filter = function (canteen) {
      const name = canteen.name.toLowerCase()
      const city = canteen.city.toLowerCase()
      if (name.indexOf(searchQuery) !== -1 || city.indexOf(searchQuery) !== -1) {
        return true
      }
      const queries = searchQuery.replace(/\s+/gim, ' ').split(' ').filter(s => s.trim().length > 1)
      return queries.every(query => name.indexOf(query) !== -1 || city.indexOf(query) !== -1)
    }
  }

  const canteens = await cachedMultiPageJSON('https://openmensa.org/api/v2/canteens', fetchConfig, event, 60 * 60 * 24)
  const canteenResults = canteens.filter(filter)
  let text
  console.log(canteenResults)
  console.log(filter)
  if (canteenResults.length === 1) {
    const canteen = canteenResults[0]

    const result = await menuMessage(canteen, { showEnablePushLink: !foundEnablePush }, event)

    if (result.meals && result.meals.length) {
      text = result.text
    } else {
      text = 'No current menu found for ' + escapeMarkdown(canteen.name) + ' in ' + escapeMarkdown(canteen.city)
    }
    if (foundEnablePush) {
      await enablePushFor(message.chat.id, canteen)
      sendPlainText(message.chat.id, 'Daily menu message enabled for ' + escapeMarkdown(canteen.name))
    } else if (foundDisablePush) {
      await disablePushFor(message.chat.id, canteen)
      sendPlainText(message.chat.id, 'Daily menu message disabled for ' + escapeMarkdown(canteen.name))
    }
  } else if (canteenResults.length > 1) {
    text = canteenResults.map(canteen => `/${canteen.id in shortNames ? shortNames[canteen.id] : ('x' + canteen.id)}\n${escapeMarkdown(canteen.name)} in ${escapeMarkdown(canteen.city)}`).join('\n\n')
  } else if (foundDisablePush) {
    await disablePush(message.chat.id)
    text = 'Daily menu messages disabled'
  } else {
    text = 'No results for ' + escapeMarkdown(message.text)
  }

  const resp = await sendPlainText(message.chat.id, text, 'MarkdownV2')
  if (!resp || !resp.ok) {
    console.error(resp)
    console.log('sendPlainText(' + message.chat.id + ', `' + text + "`, 'MarkdownV2')")
  }
  return resp
}

/**
 * Wait for requests to the worker
 */
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/push') {
    event.respondWith(handlePush(event, url, SECRET))
  } else if (url.pathname === '/updates') {
    event.respondWith(handleUpdates(event))
  } /*  else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } */ else if (url.pathname.startsWith('/favicon')) {
    event.respondWith(Response.redirect('https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/color/72x72/1F35D.png', 301))
  } else {
    event.respondWith(new Response('No handler for this request'))
  }
})

addEventListener('scheduled', (event) => {
  event.waitUntil(sendAllPush(event))
})

/**
 * Handle cron job requests
 */
async function handlePush (event, requestUrl, secret) {
  if (requestUrl.search.substring(1) !== secret) {
    return new Response('Unauthorized', { status: 403 })
  }

  event.waitUntil(sendAllPush(event))

  return new Response('Ok')
}

/**
 * Handle requests to WEBHOOK
 * https://core.telegram.org/bots/api#update
 */
function handleWebhook (event) {
  // Check secret
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  // Handle the request async
  const handler = async function () {
    const update = await event.request.json()
    await onUpdate(event, update)
  }
  event.waitUntil(handler())
  return new Response('Ok')
}

/**
 * Handle incoming Updates via getUpdates request without webhook
 * https://core.telegram.org/bots/api#getupdates
 */
async function handleUpdates (event) {
  const r = await (await fetch(apiUrl('getUpdates'))).json()
  for (let i = 0; i < r.result.length; i++) {
    event.waitUntil(onUpdate(event, r.result[i]))
  }
  return new Response('Ok')
}

/**
 * Handle incoming Update
 * https://core.telegram.org/bots/api#update
 */
async function onUpdate (event, update) {
  if ('message' in update) {
    await onMessage(event, update.message)
  }
}

/**
 * Send plain text message
 * https://core.telegram.org/bots/api#sendmessage
 */
async function sendPlainText (chatId, text, parseMode) {
  const params = {
    chat_id: chatId,
    text
  }
  if (parseMode) {
    params.parse_mode = parseMode
  }
  return (await fetch(apiUrl('sendMessage', params))).json()
}

/**
 * Set webhook to this worker's url
 * https://core.telegram.org/bots/api#setwebhook
 */
async function registerWebhook (event, requestUrl, suffix, secret) {
  // https://core.telegram.org/bots/api#setwebhook
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * Remove webhook
 * https://core.telegram.org/bots/api#setwebhook
 */
async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl (methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}
