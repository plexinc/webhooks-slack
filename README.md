In order to run this app:
 
- Install [node.js](https://nodejs.org/en/).
- Clone the repository.
- Install dependencies using `npm install`.
- Make a new app at Heroku, and add the Redis Cloud add-on (free plan) and note the app URL.
- Make a Slack webhook and note the URL, add it as a config var named SLACK_URL.
- Edit the options at the top of the index.js file.
- Deploy to Heroku
- Have anyone who wants to contribute add the webhook on https://app.plex.tv/web/app#!/account/webhooks
