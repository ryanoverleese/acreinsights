const SEED_TOKEN = [
  'eyJhbGciOiJIUzUxMiJ9.eyJpYXQiOjE3NzE4NzU2MzEsInN1YiI6ImFjcmUuaW5zaWdodHNc',
  'blhvUHZON01nUHE5SXJmeXAzVlFuWFE9PSJ9.NHxwxPQIzDPm1KQjkWVrFQuXINwi9BdsX1GG',
  'jzYKtjAWALrXC2ZLHISKXJC63cwEWXB6DNdlea6epELarr7lpA',
].join('');

const CROPX_HEADERS = {
  accept: 'application/json',
  origin: 'https://myfarm.cropx.com',
  referer: 'https://myfarm.cropx.com/',
};

async function getJwt() {
  const res = await fetch('https://app.cropx.com/api/jwttoken', {
    headers: { ...CROPX_HEADERS, authorization: `Bearer ${SEED_TOKEN}` },
  });
  const d = await res.json();
  return d.content.token;
}

exports.handler = async (event) => {
  const { uuid, start, end } = event.queryStringParameters || {};
  if (!uuid || !start || !end) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing uuid, start, or end' }) };
  }

  try {
    const token = await getJwt();
    const url = `https://app.cropx.com/weather_calc_data/${uuid}?start=${start}&end=${end}&meta=PT`;
    const res = await fetch(url, {
      headers: { ...CROPX_HEADERS, authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
