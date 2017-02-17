var express = require('express')
  , multer  = require('multer')
  , redis = require("redis")
  , lwip = require('lwip')
  , sha1 = require('sha1')
  , fs = require('fs')
  , freegeoip = require('node-freegeoip')
  , Slack = require('slack-node');

// Configuration.
var channel = process.env.SLACK_CHANNEL;
var appURL = process.env.APP_URL;

var slack = new Slack();
slack.setWebhook(process.env.SLACK_URL);
var redisClient = redis.createClient(process.env.REDISCLOUD_URL, { return_buffers : true });
var upload = multer({ storage: multer.memoryStorage() });
var app = express();

function formatTitle(metadata) {
  if (metadata.grandparentTitle) {
    return metadata.grandparentTitle;
  } else {
    var ret = metadata.title;
    if (metadata.year) {
      ret += ' (' + metadata.year + ')';
    }
    return ret;
  }
}

function formatSubtitle(metadata) {
  var ret = '';
  if (metadata.grandparentTitle) {
    if (metadata.type == 'track') {
      ret = metadata.parentTitle;
    } else if (metadata.index && metadata.parentIndex) {
      ret = "S" + metadata.parentIndex + " E" + metadata.index;
    } else if (metadata.originallyAvailableAt) {
      ret = metadata.originallyAvailableAt;
    }

    if (metadata.title) {
      ret += ' - ' + metadata.title;
    }
  } else if (metadata.type == 'movie') {
    ret = metadata.tagline;
  }

  return ret;
}

function notifySlack(imageUrl, payload, location, action) {
  var locationText = '';
  if (location) {
    locationText = ' near ' + location.city + ', ' + (location.country_code == 'US' ? location.region_name : location.country_name);
  }

  slack.webhook({
    channel: channel,
    username: "Plex",
    icon_emoji: ":plex:",
    attachments: [
      {
        fallback: "Required plain-text summary of the attachment.",
        color: "#a67a2d",
        title: formatTitle(payload.Metadata),
        text: formatSubtitle(payload.Metadata),
        thumb_url: imageUrl,
        footer: action + " by " + payload.Account.title + " on " + payload.Player.title + " from " + payload.Server.title + locationText,
        footer_icon: payload.Account.thumb
      }
    ]
  }, function(err, response) {});
}

app.post('/', upload.single('thumb'), function (req, res, next) {
  var payload = JSON.parse(req.body.payload);
  var isVideo = (payload.Metadata.librarySectionType == "movie" || payload.Metadata.librarySectionType == "show");
  var isAudio = (payload.Metadata.librarySectionType == "artist");

  if (payload.user == true && payload.Metadata && (isAudio || isVideo)) {
    var key = sha1(payload.Server.uuid + payload.Metadata.guid);

    if (payload.event == "media.play" || payload.event == "media.rate") {
      // Save the image.
      if (req.file && req.file.buffer) {
        lwip.open(req.file.buffer, 'jpg', function (err, image) {
          image.contain(75, 75, 'white', function (err, smallerImage) {
            smallerImage.toBuffer('jpg', function (err, buffer) {
              redisClient.setex(key, 7 * 24 * 60 * 60, buffer);
            });
          });
        });
      }
    }

    if ((payload.event == "media.scrobble" && isVideo) || payload.event == "media.rate") {
      // Geolocate player.
      freegeoip.getLocation(payload.Player.publicAddress, function(err, location) {

        var action;
        if (payload.event == "media.scrobble") {
          action = "played";
        } else {
          if (payload.rating > 0) {
            action = "rated ";
            for (var i = 0; i < payload.rating / 2; i++)
              action += ":star:";
          } else {
            action = "unrated";
          }
        }

        // Send the event to Slack.
        redisClient.get(key, function(err, reply) {
          if (reply) {
            notifySlack(appURL + '/images/' + key, payload, location, action);
          } else {
            notifySlack(null, payload, location, action);
          }
        });
      });
    }
  }

  res.sendStatus(200);
});

app.get('/images/:key',function(req, res, next) {
  redisClient.get(req.params.key, function(err,value) {
    if (err) {
      next(err);
    } else {
      if (!value) {
        next();
      } else {
        res.setHeader('Content-Type','image/jpeg');
        res.end(value);
      }
    }
  });
});

app.listen(process.env.PORT || 11000);
