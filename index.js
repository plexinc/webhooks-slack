const express = require('express');
const sharp = require('sharp');
const morgan = require('morgan');
const multer = require('multer');
const Redis = require('ioredis');
const request = require('request-promise-native');
const sha1 = require('sha1');
const Slack = require('slack-node');
const upload = multer({ storage: multer.memoryStorage() });

const SEVEN_DAYS = 7 * 24 * 60 * 60; // in seconds

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
  console.log(`Express app running at http://localhost:${port}`);
});

//
// routes

app.post('/', upload.single('thumb'), async(req, res, next) => {
  const payload = JSON.parse(req.body.payload);
  const isVideo = (payload.Metadata.librarySectionType === 'movie' || payload.Metadata.librarySectionType === 'show');
  const isAudio = (payload.Metadata.librarySectionType === 'artist');
  const key = sha1(payload.Server.uuid + payload.Metadata.ratingKey);

  // missing required properties
  if (!payload.user || !payload.Metadata || !(isAudio || isVideo)) {
    return res.sendStatus(400);
  }

  // retrieve cached image
  let image = await redis.getBuffer(key);

  // save new image
  if (payload.event === 'media.play' || payload.event === 'media.rate') {
    if (image) {
      console.log('[REDIS]', `Using cached image ${key}`);
    } else if (!image && req.file && req.file.buffer) {
      console.log('[REDIS]', `Saving new image ${key}`);
      image = await sharp(req.file.buffer)
        .resize(75, 75)
        .background('white')
        .embed()
        .toBuffer();

      redis.set(key, image, 'EX', SEVEN_DAYS);
    }
  }

  // post to slack
  if ((payload.event === 'media.scrobble' && isVideo) || payload.event === 'media.rate') {
    const location = await getLocation(payload.Player.publicAddress);

    let action;

    if (payload.event === 'media.scrobble') {
      action = 'played';
    } else if (payload.rating > 0) {
      action = 'rated ';
      for (var i = 0; i < payload.rating / 2; i++) {
        action += ':star:';
      }
    } else {
      action = 'unrated';
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

app.get('/images/:key', async(req, res, next) => {
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
  return request.get(`http://api.ipstack.com/${ip}?access_key=${process.env.IPSTACK_KEY}`, { json: true });
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

  return ret;
}

function notifySlack(imageUrl, payload, location, action) {
  let locationText = '';

  if (location) {
    const state = location.country_code === 'US' ? location.region_name : location.country_name;
    locationText = `near ${location.city}, ${state}`;
  }

  slack.webhook({
    channel,
    username: 'Plex',
    icon_emoji: ':plex:',
    attachments: [{
      fallback: 'Required plain-text summary of the attachment.',
      color: '#a67a2d',
      title: formatTitle(payload.Metadata),
      text: formatSubtitle(payload.Metadata),
      thumb_url: imageUrl,
      footer: `${action} by ${payload.Account.title} on ${payload.Player.title} from ${payload.Server.title} ${locationText}`,
      footer_icon: payload.Account.thumb
    }]
  }, () => {});
}
