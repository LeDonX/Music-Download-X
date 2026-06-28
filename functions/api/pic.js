const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
};

function normalizePicUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return url.replace(/\.webp(?=($|[?#]))/i, '.jpg');
}

async function getKugouPic(searchParams) {
  const songmid = searchParams.get('songmid') || '';
  const albumId = searchParams.get('albumId') || '';
  const hash = searchParams.get('hash') || '';
  const name = searchParams.get('name') || '';
  const singer = searchParams.get('singer') || '';

  if (!songmid || !hash) throw new Error('Missing Kugou songmid/hash');

  const res = await fetch('http://media.store.kugou.com/v1/get_res_privilege', {
    method: 'POST',
    headers: {
      'KG-RC': '1',
      'KG-THash': 'expand_search_manager.cpp:852736169:451',
      'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      appid: 1001,
      area_code: '1',
      behavior: 'play',
      clientver: '9020',
      need_hash_offset: 1,
      relate: 1,
      resource: [
        {
          album_audio_id: songmid,
          album_id: albumId,
          hash,
          id: 0,
          name: `${singer} - ${name}.mp3`,
          type: 'audio',
        },
      ],
      token: '',
      userid: 2626431536,
      vip: 1,
    }),
  });
  if (!res.ok) throw new Error(`Kugou pic HTTP ${res.status}`);
  const body = await res.json();
  if (body.error_code !== 0) throw new Error(body.error_msg || 'Kugou pic failed');
  const info = body.data?.[0]?.info || {};
  const img = info.imgsize?.length ? info.image?.replace('{size}', info.imgsize[0]) : info.image;
  return normalizePicUrl(img || '');
}

async function getKuwoPic(searchParams) {
  const songmid = searchParams.get('songmid') || '';
  if (!songmid) throw new Error('Missing Kuwo songmid');
  const res = await fetch(`http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${encodeURIComponent(songmid)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Kuwo pic HTTP ${res.status}`);
  const body = await res.text();
  return normalizePicUrl(/^https?:\/\//i.test(body) ? body : '');
}

function getDirectPic(searchParams) {
  const source = searchParams.get('source') || '';
  const albumId = searchParams.get('albumId') || '';
  const songmid = searchParams.get('songmid') || '';
  const img = searchParams.get('img') || '';

  if (/^https?:\/\//i.test(img)) return normalizePicUrl(img);

  if (source === 'tx' && albumId) {
    return normalizePicUrl(`https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`);
  }

  if (source === 'mg' && img) return normalizePicUrl(`http://d.musicapp.migu.cn${img}`);

  return '';
}

export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const source = searchParams.get('source') || '';

  try {
    let img = '';
    if (source === 'kg') {
      img = await getKugouPic(searchParams);
    } else if (source === 'kw') {
      img = await getKuwoPic(searchParams);
    } else if (['tx', 'wy', 'mg'].includes(source)) {
      img = getDirectPic(searchParams);
    } else {
      return new Response(JSON.stringify({ error: 'Unsupported source' }), {
        status: 400,
        headers: responseHeaders,
      });
    }

    return new Response(JSON.stringify({ img }), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, img: '' }), {
      status: 500,
      headers: responseHeaders,
    });
  }
}
