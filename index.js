const https = require("https");
const http = require("http");
const fs = require("fs");
const express = require("express");
const app = express();
const low = require("lowdb");
const FileAsync = require("lowdb/adapters/FileAsync");
const axios = require("axios");
const qs = require("qs");

/* Run command:

env WITHINGS_CLIENT_ID='redacted' \
    WITHINGS_CONSUMER_SECRET='redacted' \
    WITHINGS_REDIRECT_URI='redacted' \
    FITBIT_CLIENT_ID='redacted' \
    FITBIT_CONSUMER_SECRET='redacted' \
    FITBIT_REDIRECT_URI='redacted' \
    npm run start

*/

const {
  BASE_URL,
  WITHINGS_CLIENT_ID,
  WITHINGS_CONSUMER_SECRET,
  WITHINGS_REDIRECT_URI,
  FITBIT_CLIENT_ID,
  FITBIT_CONSUMER_SECRET,
  FITBIT_REDIRECT_URI,
  TLS_PRIVATE_KEY_PATH,
  TLS_CERT_PATH,
  TLS_FULL_CHAIN_PATH,
} = process.env;
if (
  [
    BASE_URL,
    WITHINGS_CLIENT_ID,
    WITHINGS_CONSUMER_SECRET,
    WITHINGS_REDIRECT_URI,
    FITBIT_CLIENT_ID,
    FITBIT_CONSUMER_SECRET,
    FITBIT_REDIRECT_URI,
  ].some((s) => !s)
) {
  console.error("Missing environment variables.", {
    BASE_URL,
    WITHINGS_CLIENT_ID,
    WITHINGS_CONSUMER_SECRET,
    WITHINGS_REDIRECT_URI,
    FITBIT_CLIENT_ID,
    FITBIT_CONSUMER_SECRET,
    FITBIT_REDIRECT_URI,
  });
  process.exit(1);
}

const adapter = new FileAsync("db.json");
const lowDb = low(adapter).then((db) => {
  return db.defaults({
    subscriptions: {},
    withingsTokens: {},
    fitbitTokens: {},
  });
});

var router = express.Router();

router.get("/WithingsAuth", (req, res, next) => {
  if (req.query.code) {
    exchangeForWithingsTokens();
  } else {
    showWithingsAuthPage();
  }

  function showWithingsAuthPage() {
    res.send(`
          <h1>Welcome</h1>
          <a href="https://account.withings.com/oauth2_user/authorize2?client_id=${encodeURIComponent(
            WITHINGS_CLIENT_ID
          )}&scope=user.metrics&redirect_uri=${encodeURIComponent(
      WITHINGS_REDIRECT_URI
    )}&response_type=code&state=nil">Click to Authorize</a>
      `);
  }

  function exchangeForWithingsTokens() {
    postWithingsAuthCode(req.query.code)
      .then(storeWithingsTokens)
      .then((result) =>
        res.redirect(
          `/withings-to-fitbit/FitbitAuth?withingsUserID=${encodeURIComponent(
            result.data.body.userid
          )}`
        )
      )
      .catch((err) => next(err));
  }

  function storeWithingsTokens(result) {
    return lowDb
      .then((db) =>
        db
          .get("withingsTokens")
          .set(result.data.body.userid, result.data.body)
          .write()
      )
      .then(() => result);
  }
});

router.get("/FitbitAuth", (req, res, next) => {
  if (req.query.code) {
    exchangeForFitbitTokens();
  } else if (req.query.withingsUserID) {
    showFitbitAuthPage();
  } else {
    res.redirect("/withings-to-fitbit/WithingsAuth");
  }

  function showFitbitAuthPage() {
    res.send(`
            <h1>And now Fitbit</h1>
            <a href="https://www.fitbit.com/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(
              FITBIT_CLIENT_ID
            )}&redirect_uri=${encodeURIComponent(
      FITBIT_REDIRECT_URI
    )}&scope=activity%20heartrate%20location%20nutrition%20profile%20settings%20sleep%20social%20weight&expires_in=604800&state=${encodeURIComponent(
      req.query.withingsUserID
    )}">Click to Authorize</a>
      `);
  }

  function exchangeForFitbitTokens() {
    postFitbitAuthCode(req.query.code)
      .then(storeFitbitTokens)
      .then(createWithingsNotification)
      .then(() => res.redirect("/withings-to-fitbit/Complete"))
      .catch((err) => next(err));
  }

  function createWithingsNotification(fitbitTokenData) {
    const withingsUserID = req.query.state;
    console.log("withingsUserID", withingsUserID);
    console.log("fitbitTokenData", fitbitTokenData);
    return lowDb
      .then((db) => db.get("withingsTokens").get(withingsUserID).value())
      .then((withingsTokenData) =>
        lowDb
          .then((db) =>
            db
              .get("subscriptions")
              .set(withingsUserID, fitbitTokenData.user_id)
              .write()
          )
          .then(() => {
            // const data = qs.stringify({
            //   action: "subscribe",
            //   callbackurl: BASE_URL + "/withings-to-fitbit/notification",
            //   client_id: "client_id",
            // });
            const data = `action=subscribe&callbackurl=${BASE_URL}/withings-to-fitbit/notification&client_id=client_id`;
            console.log(
              "Posting to https://wbsapi.withings.net/notify",
              data,
              "with token",
              withingsTokenData.access_token
            );
            return axios.post("https://wbsapi.withings.net/notify", data, {
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: "Basic " + withingsTokenData.access_token,
              },
            });
          })
      )
      .then((result) => {
        console.log(result.data);
      });
  }

  function storeFitbitTokens(result) {
    return lowDb
      .then((db) =>
        db.get("fitbitTokens").set(result.data.user_id, result.data).write()
      )
      .then(() => result.data);
  }
});

router.get("/Complete", (req, res, next) => {
  res.send(`
    <h1>Done</h1>
    <p>Connection made</p>
  `);
});

function postFitbitAuthCode(code) {
  const data = qs.stringify({
    clientId: FITBIT_CLIENT_ID,
    grant_type: "authorization_code",
    code: code,
    redirect_uri: FITBIT_REDIRECT_URI,
  });
  return axios.post("https://api.fitbit.com/oauth2/token", data, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + base64(FITBIT_CLIENT_ID + ":" + FITBIT_CONSUMER_SECRET),
    },
  });
}

function base64(data) {
  let buff = new Buffer.from(data, "utf-8");
  return buff.toString("base64");
}

function postWithingsAuthCode(code) {
  const data = qs.stringify({
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: WITHINGS_CLIENT_ID,
    client_secret: WITHINGS_CONSUMER_SECRET,
    code: code,
    redirect_uri: WITHINGS_REDIRECT_URI,
  });
  return axios.post("https://wbsapi.withings.net/v2/oauth2", data);
}

app.use(express.json());
app.use("/withings-to-fitbit", router);
app.get("/", (_req, res) => {
  res.redirect("/withings-to-fitbit/WithingsAuth");
});
app.use(express.static("public"));

http.createServer(app).listen(80, () => "Listening on ports 80");
try {
  const tlsOptions = {
    key: fs.readFileSync(TLS_PRIVATE_KEY_PATH || "key.pem", "utf8"),
    cert: fs.readFileSync(TLS_CERT_PATH || "cert.pem", "utf8"),
    ca: [fs.readFileSync(TLS_FULL_CHAIN_PATH || "chain.pem", "utf8")],
  };
  https
    .createServer(tlsOptions, app)
    .listen(443, () => "Listening on port 443");
} catch (err) {
  console.warn("Could not initiate HTTPS", err);
}
