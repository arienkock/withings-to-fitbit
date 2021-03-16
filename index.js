const express = require("express");
const app = express();
const low = require("lowdb");
const FileAsync = require("lowdb/adapters/FileAsync");
const axios = require("axios");
const qs = require("qs");

const {
  WITHINGS_CLIENT_ID,
  WITHINGS_CONSUMER_SECRET,
  WITHINGS_REDIRECT_URI,
} = process.env;
if (
  [WITHINGS_CLIENT_ID, WITHINGS_CONSUMER_SECRET, WITHINGS_REDIRECT_URI].some(
    (s) => !s
  )
) {
  console.error("Missing environment variables.");
  process.exit(1);
}

const adapter = new FileAsync("db.json");
const lowDb = low(adapter).then((db) => {
  return db.defaults({
    subscriptions: [],
    withingsTokens: {},
    fitbitTokens: [],
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
          <a href=https://account.withings.com/oauth2_user/authorize2?client_id=${encodeURIComponent(
            WITHINGS_CLIENT_ID
          )}&scope=user.metrics&redirect_uri=${encodeURIComponent(
      WITHINGS_REDIRECT_URI
    )}&response_type=code&state=nil>Click to Authorize</a>
      `);
  }

  function showFitbitAuthPage() {}

  function exchangeForWithingsTokens() {
    postAuthCode(req.query.code)
      .then(storeWithingsTokens)
      .then(showFitbitAuthPage)
      .then((result) => res.send(result))
      .catch((err) => next(err));
  }

  function storeWithingsTokens(result) {
    return lowDb.then((db) =>
      db
        .get("withingsTokens")
        .set(result.data.body.userid, result.data.body)
        .write()
    );
  }
});

function postAuthCode(code) {
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

app.use(express.static("public"));
app.use(express.json());
app.use("/withings-to-fitbit", router);
app.get("/", (_req, res) => {
  res.redirect("/withings-to-fitbit/WithingsAuth");
});

const tlsOptions = {
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("cert.pem"),
};

http.createServer(app).listen(80, () => "Listening on port 80");
https.createServer(tlsOptions, app).listen(443, () => "Listening on port 443");
