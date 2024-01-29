import crypto from 'node:crypto';
import express from 'express';

const env = {
  PORT: 3000,
  CAND_APP_CLIENT_ID: 'YOUR_CAND_APP_CLIENT_ID',
  CAND_APP_REDIRECT_URI: 'http://localhost:3000/callback/canpass',
};
const db = {
  codeVerifiers: {},
  bots: {},
};
const app = express();

app.get('/', async (req, res) => {
  const createCodeVerifier = () => btoa(String.fromCharCode(...new Uint8Array(crypto.getRandomValues(new Uint8Array(32)).buffer)));
  const createCodeChallenge = async (verifier) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", (new TextEncoder()).encode(verifier))))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const url = new URL('https://canpass.me/oauth2/authorize');
  const codeVerifier = createCodeVerifier();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const nonce = `${Math.random()}`;
  const state = {nonce};
  const stateString = JSON.stringify(state);
  const scopes = ['member:MOIM:product:read', 'member:MOIM:product:write', 'bot:MOIM:product:read', 'bot:MOIM:product:write', 'webhook:MOIM:product'];
  const searchParams = new URLSearchParams({
    response_type: 'code',
    action: 'signin',
    social_logins: 'all',
    client_id: env.CAND_APP_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: env.CAND_APP_REDIRECT_URI,
    scope: scopes.join(' '),
    state: stateString,
    // community_id should be included in the query
    ...req.query,
  });

  url.search = searchParams.toString();

  const urlString = url.toString();

  db.codeVerifiers[stateString] = codeVerifier;
  res.redirect(urlString);

  console.log('CANpass authorization endpoint url and used code verifier', urlString, codeVerifier);
});

app.get('/callback/canpass', async (req, res) => {
  const {state: stateString, error, error_description, code} = req.query;
  const codeVerifier = db.codeVerifiers[stateString];

  delete db.codeVerifiers[stateString];

  if (!codeVerifier) {
    res.sendStatus(400);

    return;
  }

  if (error) {
    if (error !== 'access_denied') {
      console.error(`Check the error: ${error} and ${error_description}`);
    }
    res.status(400).send(`Error: ${error} and ${error_description}`);

    return;
  }

  const tokenRes = await fetch('https://canpass.me/oauth2/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.CAND_APP_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: env.CAND_APP_REDIRECT_URI,
    }).toString(),
  });
  const tokenBody = await tokenRes.json();

  console.log('CANpass token endpoint response status and body', tokenRes.status, tokenBody);

  if (tokenRes.status !== 200) {
    res.sendStatus(400);
    return;
  }

  const meRes = await fetch('https://api.cand.xyz/me', {
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${tokenBody.access_token}`,
      'x-can-community-id': tokenBody.community_id,
    },
  });
  const meBody = await meRes.json();

  console.log('Moim GET /me response status and body', meRes.status, meBody);

  if (tokenBody.bot_access_token) {
    if (!db.bots[tokenBody.community_id]) {
      const bot = {id: tokenBody.community_id, accessToken: tokenBody.bot_access_token};

      db.bots[tokenBody.community_id] = bot;
      console.log('New bot is created and stored', bot);
    }

    const productRes = await fetch('https://api.cand.xyz/products/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${tokenBody.bot_access_token}`,
        'x-can-community-id': tokenBody.community_id,
      },
      body: JSON.stringify({
        "name": "Example fancy product",
        "type": "normal",
        "isDisplayed": true,
        "blocks": [
          {
            "type": "text",
            "content": "sample text"
          }
        ],
        "images": {
          "mobile": [
            "https://dummyimage.com/350x350/000/fff&text=Product"
          ],
          "web": [
            "https://dummyimage.com/350x350/000/fff&text=Product"
          ]
        },
        "status": "onSale",
        "price": 99,
        "normalPrice": 100,
        "originalPrice": 101,
        "supplyPrice": 80,
        "description": "description",
        "sku": "sku#1",
        "stockCount": 3,
        "weight": 0
      }),
    });
    const productBody = await productRes.json();

    console.log('Moim POST /products response status and body', productRes.status, productBody);
  }

  res.send('See the console');
});

app.post('/callback/cand', async (req, res) => {
  res.end();

  const {module, type, context, payload} = req.body;

  console.log('Webhook event given', module, type, context, payload);

  switch (`${module}:${type}`) {
    case 'MOIM:product.created': {
      const botAccessToken = await db.bots[context.originCommunityId];
      const productRes = await fetch(`https://api.cand.xyz/products/${payload.id}`, {
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${botAccessToken}`,
          'x-can-community-id': context.originCommunityId,
        },
      });
      const productBody = await productRes.json();

      console.log('Moim GET /products/${proudctId} response status and body', productRes.status, productBody);
      break;
    }
    default:
      console.warn(`No case statement available for ${module}:${type} event whose context is ${JSON.stringify(context)} and payload is ${JSON.stringify(payload)}`);
      break;
  }
});

app.listen(env.PORT, () => {
  console.log(`Listening to port ${env.PORT}`);
});
