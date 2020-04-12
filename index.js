const express = require('express');
const sharp = require('sharp');
const morgan = require('morgan');
const multer = require('multer');
const Redis = require('ioredis');
const request = require('request-promise-native');
const sha1 = require('sha1');
const Slack = require('slack-node');
const get = require('lodash.get');
const upload = multer({ storage: multer.memoryStorage() });

const SEVEN_DAYS = 7 * 24 * 60 * 60; // in seconds

const EVENT_SCROBBLE = 'media.scrobble';
const EVENT_RATE = 'media.rate';
const EVENT_PLAY = 'media.play';
const EVENT_NEW = 'library.new';
let eventWhitelist = [EVENT_SCROBBLE, EVENT_RATE, EVENT_NEW];
if (process.env.EVENT_WHITELIST) {
  eventWhitelist = process.env.EVENT_WHITELIST.split(',').map((str) =>
    str.trim()
  );
}
eventWhitelist.push(EVENT_PLAY); // images are saved on play for later use, notification not sent to slack on play

//
// setup

const channel = process.env.SLACK_CHANNEL;
const appURL = process.env.APP_URL;
const redis = new Redis(process.env.REDIS_URL);

//
// slack

const slack = new Slack();
slack.setWebhook(process.env.SLACK_URL);

//
// express

const app = express();
const port = process.env.PORT || 11000;

app.use(morgan('dev'));
app.listen(port, () => {
  console.log(`Express app running at ${port}`);
});

//
// routes

app.post('/', upload.single('thumb'), async (req, res, next) => {
  console.log(req.body.payload);
  const payload = JSON.parse(req.body.payload);
  const {
    Metadata: metadata,
    Server: server,
    Player: player,
    event,
    thumb,
    rating
  } = payload || {};
  const type = get(metadata, 'type');
  const isVideo = ['movie', 'episode', 'show'].includes(type);
  const isAudio = type === 'track';
  const key = sha1(get(server, 'uuid') + get(metadata, 'ratingKey'));
  const isScrobble = event === EVENT_SCROBBLE;
  const isRate = event === EVENT_RATE;
  const isPlay = event === EVENT_PLAY;
  const isNew = event === EVENT_NEW;

  // missing required properties
  if (!metadata || !(isAudio || isVideo) || !eventWhitelist.includes(event)) {
    return res.sendStatus(400);
  }

  // retrieve cached image
  let image = await redis.getBuffer(key);

  // save new image
  if (isPlay || isRate || isNew) {
    if (image) {
      console.log('[REDIS]', `Using cached image ${key}`);
    } else {
      let buffer;
      if (get(req, 'file.buffer')) {
        buffer = get(req, 'file.buffer');
      } else if (thumb) {
        console.log('[REDIS]', `Retrieving image from ${thumb}`);
        buffer = await request.get({
          uri: thumb,
          encoding: null
        });
      }

      if (buffer) {
        image = await sharp(buffer)
          .resize({
            height: 75,
            width: 75,
            fit: 'contain',
            background: 'white'
          })
          .toBuffer();

        console.log('[REDIS]', `Saving new image ${key}`);
        redis.set(key, image, 'EX', SEVEN_DAYS);
      }
    }
  }

  // post to slack
  if ((isScrobble && isVideo) || isRate || isNew) {
    const location = await getLocation(get(player, 'publicAddress'));

    let action;

    if (isScrobble) {
      action = 'played';
    } else if (isRate) {
      if (rating > 0) {
        action = 'rated ';
        for (var i = 0; i < rating / 2; i++) {
          action += ':star:';
        }
      } else {
        action = 'unrated';
      }
    } else if (isNew) {
      action = 'added';
    }

    if (image) {
      console.log('[SLACK]', `Sending ${key} with image`);
      notifySlack(appURL + '/images/' + key, payload, location, action);
    } else {
      console.log('[SLACK]', `Sending ${key} without image`);
      notifySlack(null, payload, location, action);
    }
  }

  res.sendStatus(200);
});

app.get('/images/:key', async (req, res, next) => {
  const exists = await redis.exists(req.params.key);

  if (!exists) {
    return next();
  }

  const image = await redis.getBuffer(req.params.key);
  sharp(image).jpeg().pipe(res);
});

//
// error handlers

app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use((err, req, res, next) => {
  res.status(err.status || 500);
  res.send(err.message);
});

//
// helpers

function getLocation(ip) {
  return request.get(
    `http://api.ipstack.com/${ip}?access_key=${process.env.IPSTACK_KEY}`,
    { json: true }
  );
}

function formatTitle(metadata) {
  if (metadata.grandparentTitle) {
    return metadata.grandparentTitle;
  } else {
    let ret = metadata.title;
    if (metadata.year) {
      ret += ` (${metadata.year})`;
    }
    return ret;
  }
}

function formatSubtitle(metadata) {
  let ret = '';

  if (metadata.grandparentTitle) {
    if (metadata.type === 'track') {
      ret = metadata.parentTitle;
    } else if (metadata.index && metadata.parentIndex) {
      ret = `S${metadata.parentIndex} E${metadata.index}`;
    } else if (metadata.originallyAvailableAt) {
      ret = metadata.originallyAvailableAt;
    }

    if (metadata.title) {
      ret += ' - ' + metadata.title;
    }
  } else if (metadata.type === 'movie') {
    ret = metadata.tagline;
  }
  if (metadata.summary) {
    ret += `\n${metadata.summary}`;
  }

  return ret;
}

function notifySlack(imageUrl, payload, location, action) {
  let locationText = '';
  if (location) {
    const state =
      location.country_code === 'US' ?
        location.region_name :
        location.country_name;
    if (state) {
      locationText = `near ${location.city}, ${state}`;
    }
  }

  const title = formatTitle(payload.Metadata);
  let footer = `${action} by ${get(payload, 'Account.title')}`;
  const player = get(payload, 'Player.title');
  if (player) {
    footer += ` on ${payload.Player.title}`;
  }
  const server = get(payload, 'Server.title');
  if (server) {
    footer += ` from ${payload.Server.title}`;
  }
  if (locationText) {
    footer += ` ${locationText}`;
  }

  slack.webhook(
    {
      channel,
      username: 'Plex',
      icon_emoji: ':plex:',
      attachments: [
        {
          fallback: title,
          color: '#e5a00d',
          title,
          text: formatSubtitle(payload.Metadata),
          thumb_url: imageUrl,
          footer,
          footer_icon: payload.Account.thumb
        }
      ]
    },
    () => {}
  );
}
