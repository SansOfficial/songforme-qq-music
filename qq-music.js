// SongforMe 的 QQ 音乐插件。非官方，和 QQ 音乐、腾讯没有关系。
// 用的是网页端的接口，随时可能变动；只读你自己账号的内容、只放你的账号本来就能放的歌，不下载、不解密。

const LANG = ["国语", "粤语", "闽南语", "日语", "韩语", "英语", "法语", "其他", "德语", "纯音乐"];
const UIN = ["uin", "wxuin", "qqmusic_uin"];
const KEY = ["qqmusic_key", "qm_keyst", "p_skey", "skey"];
const guid = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

// 请求排队发，两次之间隔一会儿，免得太快被限流
let tail = Promise.resolve();
function batch(calls) {
  const run = tail.then(async () => {
    const comm = {
      ct: 24, cv: 4747474, format: "json", platform: "yqq.json", chid: "0", notice: 0, need_new_code: 1,
      inCharset: "utf-8", outCharset: "utf-8",
      // 这三个是占位符，应用发给 QQ 音乐时才换成真的，这里看不到登录状态
      uin: login.number(...UIN), g_tk: login.hash(...KEY), g_tk_new_20200303: login.hash(...KEY),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg?_=" + Date.now(), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...calls, comm }),
      });
      if (!r.ok) throw new Error("接口返回 HTTP " + r.status);
      const d = await r.json();
      if (d.code !== 2001 && !Object.keys(calls).some(k => d[k] && d[k].code === 2001)) {
        check(d.code);
        return d;
      }
      await sleep(2500 * (attempt + 1));
    }
    throw new Error("请求过于频繁，过一会儿再试");
  });
  tail = run.catch(() => {}).then(() => sleep(400));
  return run;
}

async function call(module, method, param) {
  const r = (await batch({ req: { module, method, param } })).req;
  check(r && r.code);
  return r.data || {};
}

function check(code) {
  if ([1000, 1001, 301, 104400, 104401].includes(code)) throw { message: "QQ 音乐要重新登录", needsLogin: true };
  if (code !== 0) throw new Error("QQ 音乐接口失败 " + code);
}

const photo = (kind, mid) => mid ? `https://y.gtimg.cn/music/photo_new/${kind}R300x300M000${mid}.jpg` : "";

function song(t) {
  if (!t || !t.mid) return null;
  const album = t.album || {};
  return {
    id: t.mid, name: t.title || t.name,
    artists: (t.singer || []).map(s => ({ id: s.mid, name: s.name, avatar: photo("T001", s.mid) })),
    album: { id: album.mid, name: album.name }, cover: photo("T002", album.mid),
    duration: t.interval, date: t.time_public, language: LANG[t.language] || "其他",
    vip: !!(t.pay && t.pay.pay_play), extra: [t.id, (t.file && t.file.media_mid) || t.mid].join(","),
  };
}
// 没登录时放不了会员歌，只收免费的，免得列出来一堆点不动的
const songs = list => (list || []).map(song).filter(s => s && (login.signedIn || !s.vip));
const https = url => String(url || "").replace(/^http:/, "https:");
const plain = text => String(text || "").replace(/<\/?em>/g, "");
let searchId = "";

source({
  id: "qqmusic",
  name: "QQ 音乐",
  version: "1",
  hosts: ["u.y.qq.com", "y.gtimg.cn", "isure.stream.qqmusic.qq.com"],
  login: {
    url: "https://y.qq.com/",
    hosts: ["u.y.qq.com"],
    cookies: ["qqmusic_key", "qm_keyst"],
    uid: UIN,
  },
  searchNeedsLogin: true,
  playlistLink: "^\\s*(?:https?://[^\\s]*qq\\.com/[^\\s]*?(?:playlist/|id=))?(\\d{6,})",

  async search(query, kind, page) {
    if (page === 1 || !searchId) searchId = String(Math.floor(Math.random() * 9e16) + 1e16);
    const d = await call("music.search.SearchCgiService", "DoSearchForQQMusicDesktop", {
      searchid: searchId, query, search_type: { song: 0, artist: 1, album: 2 }[kind], num_per_page: 30, page_num: page, highlight: 0, grp: 1,
    });
    const body = d.body || {}, meta = d.meta || {};
    const list = ((body[{ song: "song", artist: "singer", album: "album" }[kind]] || {}).list) || [];
    const out = { total: meta.sum || 0, hasMore: list.length > 0 && meta.nextpage > 0 };
    if (kind === "song") out.songs = songs(list);
    if (kind === "artist") out.artists = list.map(s => ({
      id: s.singerMID, name: plain(s.singerName), songCount: s.songNum, albumCount: s.albumNum, avatar: photo("T001", s.singerMID),
    }));
    if (kind === "album") out.albums = list.map(a => ({
      id: a.albumMID, name: plain(a.albumName), date: a.publicTime, cover: photo("T002", a.albumMID),
      artists: (a.singer_list || []).length ? a.singer_list.map(x => ({ id: x.mid, name: x.name })) : [{ id: a.singerMID, name: plain(a.singerName) }],
    }));
    return out;
  },

  async stream(s) {
    const media = s.extra.split(",")[1] || s.id;
    const files = [`M800${media}.mp3`, `M500${media}.mp3`, `C400${media}.m4a`];
    const d = await call("music.vkey.GetVkey", "UrlGetVkey", {
      guid, songmid: files.map(() => s.id), songtype: files.map(() => 0), filename: files,
      uin: login.signedIn ? login.digits(...UIN) : "0", loginflag: 1, platform: "20", ctx: 0,
    });
    for (const f of files) {
      const hit = (d.midurlinfo || []).find(x => x.filename === f && x.purl);
      if (hit) return "https://isure.stream.qqmusic.qq.com/" + hit.purl;
    }
    return null;   // 会员歌或没有版权，跳过
  },

  async lyrics(s) {
    const d = await call("music.musichallSong.PlayLyricInfo", "GetPlayLyricInfo", {
      songMID: s.id, songID: Number(s.extra.split(",")[0]) || 0, crypt: 0, qrc: 0, trans: 1, roma: 0,
      lrc_t: 0, qrc_t: 0, trans_t: 0, roma_t: 0, type: 0, ct: 24, cv: 4747474,
    });
    return { lrc: atob(d.lyric || ""), trans: atob(d.trans || "") };
  },

  async related(s) {
    const songid = Number(s.extra.split(",")[0]);
    if (!songid) return { songs: [], playlists: [] };
    const module = "music.recommend.TrackRelationServer", param = { songid, songtype: 0, last_id: 0 };
    const d = await batch({ a: { module, method: "GetSimilarSongs", param }, b: { module, method: "GetRelatedPlaylist", param } });
    return {
      songs: songs(((d.a.data || {}).vecSong || []).map(x => x.track)),
      playlists: ((d.b.data || {}).vecPlaylist || []).map(p => ({ id: String(p.tid), songCount: p.songNum })),
    };
  },

  async playlist(id, max) {
    const out = [];
    let title = "";
    for (let begin = 0; begin < max; begin += 300) {
      const d = await call("music.srfDissInfo.aiDissInfo", "uniform_get_Dissinfo", {
        disstid: Number(id), userinfo: 1, tag: 1, orderlist: 1, song_begin: begin, song_num: 300, onlysonglist: 0, enc_host_uin: "",
      });
      title = (d.dirinfo && d.dirinfo.title) || title;
      const page = d.songlist || [];
      out.push(...songs(page));
      if (page.length < 300 || begin + page.length >= (d.total_song_num || 0)) break;
    }
    return { title, songs: out };
  },

  async artistSongs(id, begin, count) {
    const d = await call("musichall.song_list_server", "GetSingerSongList", { singerMid: id, order: 1, begin, num: count });
    return { total: d.totalNum, songs: songs((d.songList || []).map(x => x.songInfo)) };
  },

  async artistAlbums(id) {
    const d = await call("music.musichallAlbum.AlbumListServer", "GetAlbumList", { singerMid: id, order: 0, begin: 0, num: 80, songNumTag: 0, singerID: 0 });
    return (d.albumList || []).map(a => ({ id: a.albumMid, name: a.albumName, date: a.publishDate, type: a.albumType, cover: photo("T002", a.albumMid) }));
  },

  async albumSongs(id) {
    const d = await call("music.musichallAlbum.AlbumSongList", "GetAlbumSongList", { albumMid: id, begin: 0, num: 200, order: 2 });
    return songs((d.songList || []).map(x => x.songInfo));
  },

  // 下面要登录

  async profile() {
    const d = await call("music.UserInfo.userInfoServer", "GetLoginUserInfo", {});
    return { name: plain(d.info && d.info.nick).trim(), avatar: https(d.info && d.info.logo) };
  },

  async myPlaylists() {
    const d = await call("music.musicasset.PlaylistBaseRead", "GetPlaylistByUin", { uin: login.digits(...UIN) });
    return (d.v_playlist || []).map(p => ({
      id: String(p.tid), title: p.dirId === 201 ? "我喜欢" : p.dirName, songCount: p.songNum, cover: https(p.picUrl), liked: p.dirId === 201,
    }));
  },

  async likedSongs() {
    const out = [];
    for (let begin = 0; begin < 10000; begin += 300) {
      const d = await call("music.srfDissInfo.aiDissInfo", "uniform_get_Dissinfo", {
        disstid: 0, dirid: 201, userinfo: 1, tag: 1, orderlist: 1, song_begin: begin, song_num: 300, onlysonglist: 0, enc_host_uin: "",
      });
      const page = d.songlist || [];
      out.push(...songs(page));
      if (page.length < 300 || begin + page.length >= (d.total_song_num || 0)) break;
    }
    return out;
  },

  async collectedPlaylists() {
    const me = await call("music.srfDissInfo.aiDissInfo", "uniform_get_Dissinfo", {
      disstid: 0, dirid: 201, userinfo: 1, tag: 1, orderlist: 1, song_begin: 0, song_num: 1, onlysonglist: 0, enc_host_uin: "",
    });
    const uin = me.encrypt_login || (me.dirinfo && me.dirinfo.encrypt_uin);
    if (!uin) return [];
    const out = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const d = await call("music.musicasset.PlaylistFavRead", "CgiGetPlaylistFavInfo", { uin, offset, size: 100 });
      const list = d.v_list || [];
      out.push(...list.map(p => ({ id: String(p.tid), title: p.name, songCount: p.songnum, cover: https(p.logo) })));
      if (list.length < 100 || !d.hasmore) break;
    }
    return out;
  },

  async recentPlays() {
    const d = await call("music.musicasset.PlayRecentlyRead", "GetPlayRecentlyInfo", { type: 2, updateTime: 0, lastTime: 0, requestCnt: 2500 });
    const list = d.songList || (d.data && d.data.songList) || [];
    return list.map(x => ({ song: song(x.track), time: x.lastTime, count: x.listenCnt })).filter(x => x.song);
  },
});
