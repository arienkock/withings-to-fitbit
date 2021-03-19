const https = require("https");
const http = require("http");
const fs = require("fs");
const express = require("express");
const app = express();
const low = require("lowdb");
const FileAsync = require("lowdb/adapters/FileAsync");
const axios = require("axios");
const qs = require("qs");
const morgan = require("morgan");

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

router.post("/WithingsAuth", (req, res, next) => {
  getTokenData(req.body.userid)
    .then(getWithingsMeasurements)
    .then(logFitbitData)
    .then(() => res.send("ok"))
    .catch((err) => next(err));

  function getTokenData(withingsUserId) {
    return lowDb
      .then((db) => db.get("subscriptions").get(withingsUserId).value())
      .then((fitbitUserId) =>
        Promise.all([
          getWithingsAccessToken(withingsUserId),
          getFitbitAccessToken(fitbitUserId),
        ])
      )
      .then(([withingsTokenData, fitbitTokenData]) => ({
        withingsTokenData,
        fitbitTokenData,
      }));
  }

  function getWithingsMeasurements(tokens) {
    const { withingsTokenData } = tokens;
    return axiosPost(
      "https://wbsapi.withings.net/measure",
      qs.stringify({
        action: "getmeas",
        startdate: req.body.startdate,
        enddate: req.body.enddate,
        category: "1",
        meastypes: "1,6",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Bearer " + withingsTokenData.access_token,
        },
      }
    ).then((result) => ({ measures: result.data, tokens }));
  }

  function logFitbitData(data) {
    const {
      measures,
      tokens: { fitbitTokenData },
    } = data;
    const fatMeasure = measures.body.measuregrps[0].measures.find(
      (m) => (m.type = 6)
    );
    const weightMeasure = measures.body.measuregrps[0].measures.find(
      (m) => (m.type = 1)
    );
    const date = new Date(
      measures.body.measuregrps[0].date * 1000
    ).toISOString();
    return Promise.all([
      axiosPost(
        `https://api.fitbit.com/1/user/${fitbitTokenData.user_id}/body/log/fat.json`,
        qs.stringify({
          fat:
            new Number(
              fatMeasure.value * Math.pow(10, fatMeasure.unit)
            ).toFixed(2) + "",
          date: date.substring(0, 10),
          time: date.substring(11, 19),
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: "Bearer " + fitbitTokenData.access_token,
          },
        }
      ),
      axiosPost(
        `https://api.fitbit.com/1/user/${fitbitTokenData.user_id}/body/log/weight.json`,
        qs.stringify({
          weight:
            new Number(
              weightMeasure.value * Math.pow(10, weightMeasure.unit)
            ).toFixed(2) + "",
          date: date.substring(0, 10),
          time: date.substring(11, 19),
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: "Bearer " + fitbitTokenData.access_token,
          },
        }
      ),
    ]);
  }

  function getWithingsAccessToken(withingsUserId) {
    return lowDb
      .then((db) => db.get("withingsTokens").get(withingsUserId).value())
      .then(refreshWithingsToken)
      .then(storeWithingsTokens);
  }
  function getFitbitAccessToken(fitbitUserId) {
    return lowDb
      .then((db) => db.get("fitbitTokens").get(fitbitUserId).value())
      .then(refreshFitbitToken)
      .then(storeFitbitTokens);
  }

  function refreshWithingsToken(withingsTokenData) {
    const data = qs.stringify({
      action: "requesttoken",
      client_id: WITHINGS_CLIENT_ID,
      client_secret: WITHINGS_CONSUMER_SECRET,
      grant_type: "refresh_token",
      refresh_token: withingsTokenData.refresh_token,
    });
    return axiosPost("https://wbsapi.withings.net/v2/oauth2", data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
  }

  function refreshFitbitToken(fitbitTokenData) {
    const data = qs.stringify({
      grant_type: "refresh_token",
      refresh_token: fitbitTokenData.refresh_token,
    });
    return axiosPost("https://api.fitbit.com/oauth2/token", data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " + base64(FITBIT_CLIENT_ID + ":" + FITBIT_CONSUMER_SECRET),
      },
    });
  }
});
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
      .then((tokenData) =>
        res.redirect(
          `/withings-to-fitbit/FitbitAuth?withingsUserID=${encodeURIComponent(
            tokenData.userid
          )}`
        )
      )
      .catch((err) => next(err));
  }
});

function storeWithingsTokens(result) {
  return lowDb
    .then((db) =>
      db
        .get("withingsTokens")
        .set(result.data.body.userid, result.data.body)
        .write()
    )
    .then(() => result.data.body);
}

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
            const data = qs.stringify({
              action: "subscribe",
              callbackurl: WITHINGS_REDIRECT_URI,
            });
            return axiosPost("https://wbsapi.withings.net/notify", data, {
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: "Bearer " + withingsTokenData.access_token,
              },
            });
          })
      );
  }
});

function storeFitbitTokens(result) {
  return lowDb
    .then((db) =>
      db.get("fitbitTokens").set(result.data.user_id, result.data).write()
    )
    .then(() => result.data);
}

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
  return axiosPost("https://api.fitbit.com/oauth2/token", data, {
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
  return axiosPost("https://wbsapi.withings.net/v2/oauth2", data);
}

function axiosPost(url, data, config) {
  return axios.post(url, data, config).then(
    (response) => {
      console.log(`Axios POST
    url:        ${url}
    request:    ${JSON.stringify(data)}
    response:   ${JSON.stringify(response.data)}
    config:     ${JSON.stringify(response.config)}
    status:     ${JSON.stringify(response.status)}
    `);
      return response;
    },
    (error) => {
      console.error(error);
      throw error;
    }
  );
}

app.use(morgan("combined"));
app.use(express.json());
app.use(express.urlencoded());
app.use((req, _res, next) => {
  if (req.body && Object.keys(req.body).length) {
    console.log("BODY\n" + JSON.stringify(req.body));
  }
  next();
});
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
