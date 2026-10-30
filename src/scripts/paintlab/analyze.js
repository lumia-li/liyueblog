/**
 * 图像分析引擎：把任意图片转成「一笔一笔」的笔迹数据。
 * 从 paintlab.html 原样抽取（算法未改动），仅做作用域化与导出。
 * analyze(src, W0, H0, onStage) -> { w, h, total, rois, layers, s }
 *   s: [笔宽, 起始ms, 时长ms, 颜色, x0,y0, x1,y1, ...]
 *   layers: [层号, 层名, 起始笔索引, 结束笔索引]
 */

var clamp = function(v,a,b){ return v<a?a:(v>b?b:v); };
var TAU = Math.PI*2;

function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hex3(r,g,b){
  var s = '#';
  s += ('0'+clamp(Math.round(r),0,255).toString(16)).slice(-2);
  s += ('0'+clamp(Math.round(g),0,255).toString(16)).slice(-2);
  s += ('0'+clamp(Math.round(b),0,255).toString(16)).slice(-2);
  return s;
}
function fmtTime(ms){
  var s = Math.floor(ms/1000);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

/* 可分离滑窗盒式模糊（O(n)），passes 次 ≈ 高斯 */
function boxBlur(src, w, h, r, passes){
  if (r < 1) return Float32Array.from(src);
  var a = Float32Array.from(src), b = new Float32Array(w*h);
  var k = 2*r+1, x, y, o, sum, p;
  for (p = 0; p < (passes||2); p++){
    for (y = 0; y < h; y++){
      o = y*w; sum = 0;
      for (x = -r; x <= r; x++) sum += a[o + clamp(x,0,w-1)];
      for (x = 0; x < w; x++){
        b[o+x] = sum / k;
        sum += a[o + Math.min(x+r+1, w-1)] - a[o + Math.max(x-r, 0)];
      }
    }
    for (x = 0; x < w; x++){
      sum = 0;
      for (y = -r; y <= r; y++) sum += b[clamp(y,0,h-1)*w + x];
      for (y = 0; y < h; y++){
        a[y*w+x] = sum / k;
        sum += b[Math.min(y+r+1, h-1)*w + x] - b[Math.max(y-r, 0)*w + x];
      }
    }
  }
  return a;
}
function percentile(arr, p){
  var n = arr.length, step = Math.max(1, Math.floor(n/20000)), tmp = [];
  for (var i = 0; i < n; i += step) tmp.push(arr[i]);
  tmp.sort(function(a,b){ return a-b; });
  return tmp[Math.min(tmp.length-1, Math.floor(tmp.length*p))] || 0;
}
/* 积分图，用于 ROI 密度 */
function integral(a, w, h){
  var ii = new Float64Array((w+1)*(h+1));
  for (var y = 0; y < h; y++){
    var rowSum = 0, o = (y+1)*(w+1), po = y*(w+1);
    for (var x = 0; x < w; x++){
      rowSum += a[y*w+x];
      ii[o+x+1] = ii[po+x+1] + rowSum;
    }
  }
  return ii;
}

/* ===== 分析参数 ===== */
var AN_AREA = 1050000;     // 分析分辨率目标像素数（与图片大小无关，自动适应）
var AN_LONG = 1400;        // 分析长边上限
var AN_SHORT = 220;        // 分析短边下限
var REF_LONG = 1400;       // 对照图长边上限（保持比例）
var REF_AREA = 376920;     // 基准分析面积（用于把笔触尺寸归一化到"构图占比"）

function analysisSize(w, h){
  var s = Math.min(1, Math.sqrt(AN_AREA/(w*h)));
  s = Math.min(s, AN_LONG/Math.max(w,h));
  s = Math.max(s, Math.min(1, AN_SHORT/Math.min(w,h)));
  return [ Math.max(24, Math.round(w*s)), Math.max(24, Math.round(h*s)) ];
}

function analyze(src, W0, H0, onStage){
  var sz = analysisSize(W0, H0);
  var W = sz[0], H = sz[1];
  var k = W0 / W;                       // 分析像素 -> 输出像素
  var u = Math.sqrt((W*H)/REF_AREA);    // 笔触尺寸归一化
  var N = W*H;

  /* ---- 缩到分析分辨率，取像素 ---- */
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d', {willReadFrequently:true});
  // 透明 PNG 先垫白纸，否则透明区会被当成黑色参与分析
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, W, H);
  var px = ctx.getImageData(0,0,W,H).data;

  var R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  var lum = new Float32Array(N), sat = new Float32Array(N);
  var i, p, r, g, b, mx, mn;
  for (i = 0; i < N; i++){
    p = i*4;
    r = px[p]/255; g = px[p+1]/255; b = px[p+2]/255;
    R[i] = r; G[i] = g; B[i] = b;
    lum[i] = 0.299*r + 0.587*g + 0.114*b;
    mx = Math.max(r,g,b); mn = Math.min(r,g,b);
    sat[i] = mx > 1e-6 ? (mx-mn)/mx : 0;
  }

  /* ---- 模糊（不同层用不同半径采样颜色） ---- */
  var b0 = [boxBlur(R,W,H,2,2), boxBlur(G,W,H,2,2), boxBlur(B,W,H,2,2)];
  var b1 = [boxBlur(R,W,H,1,2), boxBlur(G,W,H,1,2), boxBlur(B,W,H,1,2)];

  /* ---- 结构张量：小窗口贴边，大窗口给连贯笔势 ---- */
  var gx = new Float32Array(N), gy = new Float32Array(N);
  var x, y;
  for (y = 0; y < H; y++){
    for (x = 0; x < W; x++){
      var xm = x > 0 ? x-1 : 0, xp = x < W-1 ? x+1 : W-1;
      var ym = y > 0 ? y-1 : 0, yp = y < H-1 ? y+1 : H-1;
      gx[y*W+x] = (lum[y*W+xp] - lum[y*W+xm]) * 0.5;
      gy[y*W+x] = (lum[yp*W+x] - lum[ym*W+x]) * 0.5;
    }
  }
  var gxx = new Float32Array(N), gyy = new Float32Array(N), gxy = new Float32Array(N);
  for (i = 0; i < N; i++){ gxx[i] = gx[i]*gx[i]; gyy[i] = gy[i]*gy[i]; gxy[i] = gx[i]*gy[i]; }

  var rS = Math.max(1, Math.round(3*u));
  var rL = Math.max(2, Math.round(8*u));
  var Jxx = boxBlur(gxx,W,H,rS,2), Jyy = boxBlur(gyy,W,H,rS,2), Jxy = boxBlur(gxy,W,H,rS,2);
  var Kxx = boxBlur(gxx,W,H,rL,2), Kyy = boxBlur(gyy,W,H,rL,2), Kxy = boxBlur(gxy,W,H,rL,2);

  var phi = new Float32Array(N), coh = new Float32Array(N);
  var phi2 = new Float32Array(N), coh2 = new Float32Array(N);
  var mag = new Float32Array(N);
  for (i = 0; i < N; i++){
    var tr = Jxx[i]+Jyy[i];
    phi[i]  = 0.5*Math.atan2(2*Jxy[i], Jxx[i]-Jyy[i]+1e-9) + Math.PI/2;
    coh[i]  = Math.sqrt((Jxx[i]-Jyy[i])*(Jxx[i]-Jyy[i]) + 4*Jxy[i]*Jxy[i]) / (tr+1e-9);
    var tr2 = Kxx[i]+Kyy[i];
    phi2[i] = 0.5*Math.atan2(2*Kxy[i], Kxx[i]-Kyy[i]+1e-9) + Math.PI/2;
    coh2[i]= Math.sqrt((Kxx[i]-Kyy[i])*(Kxx[i]-Kyy[i]) + 4*Kxy[i]*Kxy[i]) / (tr2+1e-9);
    mag[i] = Math.sqrt(Math.max(tr,0));
  }
  var p992 = percentile(mag, 0.992) + 1e-9;
  var edge = new Float32Array(N);
  for (i = 0; i < N; i++) edge[i] = clamp(mag[i]/p992, 0, 1);

  /* ---- 局部对比度 = 局部标准差 + 边缘能量 ---- */
  var mu  = boxBlur(lum,W,H,Math.max(1,Math.round(3*u)),2);
  var mu2 = boxBlur((function(){ var a = new Float32Array(N); for (var q=0;q<N;q++) a[q]=lum[q]*lum[q]; return a; })(),W,H,Math.max(1,Math.round(3*u)),2);
  var std = new Float32Array(N), detail = new Float32Array(N);
  for (i = 0; i < N; i++){
    var v = mu2[i] - mu[i]*mu[i];
    std[i] = Math.sqrt(Math.max(v,0));
  }
  var p99 = percentile(std, 0.99) + 1e-9;
  var detSum = 0;
  for (i = 0; i < N; i++){
    detail[i] = clamp(0.85*std[i]/p99 + 0.65*edge[i], 0, 1.6);
    detSum += detail[i];
  }
  var meanDetail = detSum/N;

  /* ---- k-means 分区（亮度/饱和度/两个色差通道） ---- */
  var K = 8, iters = 12;
  var ns = Math.min(N, 9000), stride = Math.max(1, Math.floor(N/ns));
  var S = [], feat = new Float32Array(4*ns), cnt = 0;
  for (i = 0; i < N && cnt < ns; i += stride){
    feat[cnt*4  ] = lum[i];
    feat[cnt*4+1] = sat[i]*0.9;
    feat[cnt*4+2] = (R[i]-G[i])*0.6;
    feat[cnt*4+3] = (B[i]-G[i])*0.6;
    S.push(i); cnt++;
  }
  var mn4 = [1e9,1e9,1e9,1e9], sd4 = [0,0,0,0], c, j4;
  for (c = 0; c < 4; c++){
    var sum = 0, sum2 = 0;
    for (i = 0; i < cnt; i++){ sum += feat[i*4+c]; sum2 += feat[i*4+c]*feat[i*4+c]; }
    mn4[c] = sum/cnt;
    sd4[c] = Math.sqrt(Math.max(sum2/cnt - mn4[c]*mn4[c], 1e-9));
  }
  for (i = 0; i < cnt; i++) for (c = 0; c < 4; c++) feat[i*4+c] = (feat[i*4+c]-mn4[c])/sd4[c];

  var rndK = mulberry32(7);
  var C = [];
  for (c = 0; c < K; c++){
    var pi = Math.floor(rndK()*cnt);
    C.push([feat[pi*4], feat[pi*4+1], feat[pi*4+2], feat[pi*4+3]]);
  }
  var lab = new Int32Array(cnt);
  for (var it = 0; it < iters; it++){
    for (i = 0; i < cnt; i++){
      var bd = 1e18, bc = 0;
      for (c = 0; c < K; c++){
        var d0 = feat[i*4]-C[c][0], d1 = feat[i*4+1]-C[c][1],
            d2 = feat[i*4+2]-C[c][2], d3 = feat[i*4+3]-C[c][3];
        var dd2 = d0*d0+d1*d1+d2*d2+d3*d3;
        if (dd2 < bd){ bd = dd2; bc = c; }
      }
      lab[i] = bc;
    }
    var acc = [], num = [];
    for (c = 0; c < K; c++){ acc.push([0,0,0,0]); num.push(0); }
    for (i = 0; i < cnt; i++){
      var L2 = lab[i]; num[L2]++;
      for (j4 = 0; j4 < 4; j4++) acc[L2][j4] += feat[i*4+j4];
    }
    for (c = 0; c < K; c++) if (num[c] > 0) for (j4 = 0; j4 < 4; j4++) C[c][j4] = acc[c][j4]/num[c];
  }
  /* 全图上色标签 + 区域均色 + 区域面积 */
  var region = new Uint8Array(N);
  var rSum = new Float32Array(K*3), rNum = new Float32Array(K);
  for (i = 0; i < N; i++){
    var f0 = (lum[i]-mn4[0])/sd4[0], f1 = (sat[i]*0.9-mn4[1])/sd4[1],
        f2 = ((R[i]-G[i])*0.6-mn4[2])/sd4[2], f3 = ((B[i]-G[i])*0.6-mn4[3])/sd4[3];
    var best = 1e18, bc2 = 0;
    for (c = 0; c < K; c++){
      var e0 = f0-C[c][0], e1 = f1-C[c][1], e2 = f2-C[c][2], e3 = f3-C[c][3];
      var ee = e0*e0+e1*e1+e2*e2+e3*e3;
      if (ee < best){ best = ee; bc2 = c; }
    }
    region[i] = bc2;
    rSum[bc2*3] += R[i]; rSum[bc2*3+1] += G[i]; rSum[bc2*3+2] += B[i]; rNum[bc2]++;
  }
  var rCol = [], rArea = [];
  for (c = 0; c < K; c++){
    var nn = Math.max(rNum[c], 1);
    rCol.push([rSum[c*3]/nn*255, rSum[c*3+1]/nn*255, rSum[c*3+2]/nn*255]);
    rArea.push(rNum[c]/N);
  }

  /* ---- 采样 / 取色 ---- */
  function idxAt(x, y){
    var xi = x|0, yi = y|0;
    if (xi < 0) xi = 0; else if (xi >= W) xi = W-1;
    if (yi < 0) yi = 0; else if (yi >= H) yi = H-1;
    return yi*W + xi;
  }
  function rgbAt(x, y){
    var q = idxAt(x,y);
    return [b0[0][q]*255, b0[1][q]*255, b0[2][q]*255];
  }
  function colAt(x, y, mode, mixRegion){
    var q = idxAt(x,y), cr, cg, cb;
    if (mode === 'raw'){ cr = R[q]*255; cg = G[q]*255; cb = B[q]*255; }
    else if (mode === 'fine'){
      cr = b1[0][q]*255*0.55 + R[q]*255*0.45;
      cg = b1[1][q]*255*0.55 + G[q]*255*0.45;
      cb = b1[2][q]*255*0.55 + B[q]*255*0.45;
    } else if (mode === 'block'){ cr = b0[0][q]*255; cg = b0[1][q]*255; cb = b0[2][q]*255; }
    else { cr = b1[0][q]*255; cg = b1[1][q]*255; cb = b1[2][q]*255; }
    if (mixRegion != null){
      var rc = rCol[mixRegion];
      cr = cr*0.8 + rc[0]*0.2; cg = cg*0.8 + rc[1]*0.2; cb = cb*0.8 + rc[2]*0.2;
    }
    return hex3(cr, cg, cb);
  }
  function dirAt(x,y){ return phi[idxAt(x,y)]; }
  function cohAt(x,y){ return coh[idxAt(x,y)]; }
  function detAt(x,y){ return detail[idxAt(x,y)]; }

  /* ---- 笔触工厂 ---- */
  var A = {
    W:W, H:H, k:k, u:u, N:N,
    rgb: R, G: G, B: B, lum: lum, edge: edge, detail: detail, region: region,
    rArea: rArea, rois: []
  };

  var rnd = mulberry32(20240607);
  function un(a,b){ return a + (b-a)*rnd(); }

  function flowDir(x, y, jitter){
    var q = idxAt(x,y), ang = coh[q] > 0.20 ? phi[q] : phi2[q];
    ang += (rnd()*2-1)*jitter;
    if (rnd() < 0.5) ang += Math.PI;
    return ang;
  }
  function arcPts(x, y, ang, length, n, curl, wobble){
    var pts = [], a = ang, step = length/Math.max(1,n-1), cx = x, cy = y;
    for (var q = 0; q < n; q++){
      pts.push(cx, cy);
      a += curl*step;
      if (wobble) a += (rnd()*2-1)*wobble;
      cx += Math.cos(a)*step; cy += Math.sin(a)*step;
    }
    return pts;
  }
  function finishStroke(pts, width, color){
    var out = [], q;
    for (q = 0; q < pts.length; q += 2){
      out.push(Math.round(pts[q]*k*10)/10, Math.round(pts[q+1]*k*10)/10);
    }
    return { p: out, w: Math.round(width*k*10)/10, c: color };
  }
  /* 沿笔触等距采样 5 点，算最大通道色差（判断这一笔是否横跨了两个色块） */
  function spread5(pts){
    var n = pts.length/2, cs = [], i, j, m = 0;
    for (i = 0; i < 5; i++){
      var f = (i/4)*(n-1), ia = Math.min(n-2, Math.floor(f)), fr = f-ia;
      var x0 = pts[2*ia], y0 = pts[2*ia+1];
      cs.push(rgbAt(x0 + (pts[2*ia+2]-x0)*fr, y0 + (pts[2*ia+3]-y0)*fr));
    }
    for (i = 0; i < 5; i++) for (j = i+1; j < 5; j++){
      m = Math.max(m, Math.abs(cs[i][0]-cs[j][0]), Math.abs(cs[i][1]-cs[j][1]),
                   Math.abs(cs[i][2]-cs[j][2]));
    }
    return m;
  }
  /* 核心：落一笔
     guard：不跨色块。色差大先"沿法向挪到色块内侧"（贴着边界走），再不行就缩短收窄 */
  function oneStroke(x, y, ang, ln, wd, curlRng, wobble, n, mode, guard, mixRegion){
    var TH = 26, NN = Math.max(2, n);
    function gen(cx, cy, L){
      var curl = (rnd()*2-1)*curlRng/Math.max(L,1);
      return arcPts(cx - Math.cos(ang)*L*0.5, cy - Math.sin(ang)*L*0.5, ang, L, NN, curl, wobble);
    }
    var pts = gen(x, y, ln), sp = guard ? spread5(pts) : 0;
    if (guard && sp > TH){
      var nx = Math.cos(ang + Math.PI/2), ny = Math.sin(ang + Math.PI/2);
      var off = Math.max(1, wd*0.6);
      for (var s2 = 0; s2 < 2; s2++){
        var sg = s2 ? -1 : 1;
        var p2 = gen(x + nx*off*sg, y + ny*off*sg, ln), sp2 = spread5(p2);
        if (sp2 < sp){ sp = sp2; pts = p2; }
      }
    }
    for (var attempt = 0; attempt < 3 && guard && sp > TH; attempt++){
      var mi = ((pts.length/2)|0)*2 - 2; if (mi < 0) mi = 0;
      x = pts[mi]; y = pts[mi+1];
      ln *= 0.62; wd *= 0.86;
      if (ln < 2.2) break;
      pts = gen(x, y, ln); sp = spread5(pts);
    }
    var mx2 = ((pts.length/2)|0)*2 - 2; if (mx2 < 0) mx2 = 0;
    var col = colAt(pts[mx2], pts[mx2+1], mode, mixRegion);
    return finishStroke(pts, Math.max(wd, 0.8), col);
  }
  /* 抖动排序：key 只算一次（不能把 rnd 放进比较函数，否则等于随机顺序） */
  function sortJitter(arr, keyFn, amp){
    var keyed = arr.map(function(s, i){ return [ keyFn(s) + rnd()*amp, i ]; });
    keyed.sort(function(a,b){ return a[0]-b[0]; });
    var out = new Array(keyed.length);
    for (var q = 0; q < keyed.length; q++) out[q] = arr[keyed[q][1]];
    return out;
  }
  /* 就近游走：在给定的一堆笔里，从 (sx,sy) 出发，每次落"离手最近的那一笔"。
     用细网格 + 环形搜索，避免 O(n^2)，找不到时才退化成全量线性扫描。 */
  function walkNN(arr, sx, sy, cell){
    var m = arr.length;
    if (m < 3) return arr.slice();
    var i, j, s, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (i = 0; i < m; i++){
      s = arr[i]; s._j = i;
      if (s.p[0] < minX) minX = s.p[0];
      if (s.p[0] > maxX) maxX = s.p[0];
      if (s.p[1] < minY) minY = s.p[1];
      if (s.p[1] > maxY) maxY = s.p[1];
    }
    var cols = Math.max(1, Math.ceil((maxX-minX)/cell)+1);
    var rows = Math.max(1, Math.ceil((maxY-minY)/cell)+1);
    var buckets = new Array(cols*rows);
    for (i = 0; i < m; i++){
      s = arr[i];
      var bx = clamp(Math.floor((s.p[0]-minX)/cell), 0, cols-1);
      var by = clamp(Math.floor((s.p[1]-minY)/cell), 0, rows-1);
      var bi = by*cols + bx;
      if (!buckets[bi]) buckets[bi] = [];
      buckets[bi].push(s);
    }
    var used = new Uint8Array(m), out = [], left = m;
    var cx = sx, cy = sy, CAP = 5;
    while (left > 0){
      var best = null, bestD = Infinity;
      var gx = clamp(Math.floor((cx-minX)/cell), 0, cols-1);
      var gy = clamp(Math.floor((cy-minY)/cell), 0, rows-1);
      for (var r = 0; r <= CAP; r++){
        for (var oy = -r; oy <= r; oy++){
          var yy = gy + oy;
          if (yy < 0 || yy >= rows) continue;
          for (var ox = -r; ox <= r; ox++){
            if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
            var xx = gx + ox;
            if (xx < 0 || xx >= cols) continue;
            var arr2 = buckets[yy*cols + xx];
            if (!arr2) continue;
            for (j = 0; j < arr2.length; j++){
              var t = arr2[j];
              if (used[t._j]) continue;
              var dx = t.p[0]-cx, dy = t.p[1]-cy, dd = dx*dx + dy*dy;
              if (dd < bestD){ bestD = dd; best = t; }
            }
          }
        }
        if (best) break;
      }
      if (!best){                       // 附近空了，全量兜底（同时起到"跨块"的作用）
        for (i = 0; i < m; i++){
          s = arr[i];
          if (used[s._j]) continue;
          var dx2 = s.p[0]-cx, dy2 = s.p[1]-cy, dd2 = dx2*dx2 + dy2*dy2;
          if (dd2 < bestD){ bestD = dd2; best = s; }
        }
        if (!best) break;
      }
      used[best._j] = 1;
      out.push(best);
      cx = best.p[best.p.length-2];
      cy = best.p[best.p.length-1];
      left--;
    }
    return out;
  }

  /* 像人一样落笔：把画面分成几个"工作区"，在一个区里连续画（就近游走），
     画完提笔去下一块；偶尔随机跳到远处补两笔，像回头收拾细节。 */
  function humanOrder(list){
    var n = list.length;
    if (n < 8) return list;
    var Wout = W*k, Hout = H*k, NB = 7;
    var bw = Wout/NB, bh = Hout/NB;
    var cells = new Array(NB*NB), i, s, bx, by, id;
    for (i = 0; i < n; i++){
      s = list[i];
      bx = clamp(Math.floor(s.p[0]/bw), 0, NB-1);
      by = clamp(Math.floor(s.p[1]/bh), 0, NB-1);
      id = by*NB + bx;
      if (!cells[id]) cells[id] = [];
      cells[id].push(s);
    }
    var alive = [], done = {};
    for (i = 0; i < cells.length; i++) if (cells[i] && cells[i].length) alive.push(i);

    var fp = rois.length ? rois[0] : null;
    var curX = fp ? fp[0]*k : 0, curY = fp ? fp[1]*k : 0;
    var out = [], leftB = alive.length, span = Math.max(Wout, Hout);
    while (leftB > 0){
      var pick = -1, pd = Infinity, k2;
      for (i = 0; i < alive.length; i++){
        id = alive[i];
        if (done[id]) continue;
        var ccx = ((id % NB) + 0.5)*bw, ccy = (Math.floor(id/NB) + 0.5)*bh;
        var d2 = (ccx-curX)*(ccx-curX) + (ccy-curY)*(ccy-curY);
        if (d2 < pd){ pd = d2; pick = id; }
      }
      if (pick < 0) break;
      // 离得远的时候，偶尔随手挑一块远处的画（回头补细节的感觉）
      if (pd > (span*0.3)*(span*0.3) && rnd() < 0.25){
        var pool = [];
        for (i = 0; i < alive.length; i++) if (!done[alive[i]]) pool.push(alive[i]);
        if (pool.length) pick = pool[Math.floor(rnd()*pool.length)];
      }
      done[pick] = 1; leftB--;
      var chunk = walkNN(cells[pick], curX, curY, Math.max(16, Math.max(bw, bh)/5));
      for (k2 = 0; k2 < chunk.length; k2++) out.push(chunk[k2]);
      var lastS = chunk[chunk.length-1];
      curX = lastS.p[lastS.p.length-2];
      curY = lastS.p[lastS.p.length-1];
    }
    return out;
  }
  /* 按权重无放回抽样 */
  function subsample(cands, n){
    if (cands.length <= n) return cands.map(function(c){ return c[1]; });
    var keyed = cands.map(function(c, ix){
      return [ -Math.log(Math.max(rnd(), 1e-9))/Math.max(c[0], 1e-6), ix ];
    });
    keyed.sort(function(a,b){ return a[0]-b[0]; });
    var keep = keyed.slice(0, n).map(function(a){ return a[1]; });
    keep.sort(function(a,b){ return a-b; });
    return keep.map(function(ix){ return cands[ix][1]; });
  }

  /* ---- 层 1：铺底大笔（按区域面积从大到小） ---- */
  function layer1(){
    var cell = 30*u, groups = [], c;
    for (c = 0; c < K; c++) groups.push([]);
    var y = -cell*0.4, row = 0;
    while (y < H + cell*0.4){
      var x = -cell*0.4 + (row % 2 ? cell*0.4 : 0);
      while (x < W + cell*0.4){
        var jx = x + (rnd()*2-1)*cell*0.25, jy = y + (rnd()*2-1)*cell*0.25;
        if (jx >= 0 && jx < W && jy >= 0 && jy < H){
          var reg = region[idxAt(jx,jy)], ang;
          if (cohAt(jx,jy) > 0.22) ang = dirAt(jx,jy) + (rnd()*2-1)*0.12;
          else ang = (rnd()*2-1)*0.35 + (rnd() < 0.7 ? 0 : Math.PI/2);
          var ln = cell*un(2.2,3.4), wd = cell*un(0.85,1.2);
          var sc = 1/(1 + 4*Math.min(detAt(jx,jy), 1.2));
          ln *= sc; wd *= (0.35 + 0.65*sc);
          groups[reg].push(oneStroke(jx, jy, ang, ln, wd, 0.5, 0.015, 5, 'block', true, reg));
        }
        x += cell*0.62;
      }
      y += cell*0.58; row++;
    }
    var order = [];
    for (c = 0; c < K; c++) order.push(c);
    order.sort(function(a,b){ return rArea[b]-rArea[a]; });
    var out = [];
    order.forEach(function(cc){
      var g = humanOrder(groups[cc]);
      out = out.concat(g);
    });
    return out;
  }

  /* ---- 层 2：中景长笔 ---- */
  function layer2(){
    var step = 14.5*u, out = [], y = step*0.5;
    while (y < H){
      var x = step*0.5;
      while (x < W){
        var jx = x + (rnd()*2-1)*step*0.45, jy = y + (rnd()*2-1)*step*0.45;
        if (jx >= 0 && jx < W && jy >= 0 && jy < H){
          var d = detAt(jx,jy);
          if (d < 0.8 && (d > 0.04 || rnd() < 0.72)){
            var ang = flowDir(jx, jy, 0.20);
            var sc = 1/(1 + 2.6*Math.max(0, d-0.08));
            var ln = step*(d < 0.2 ? un(2.1,2.9) : un(1.3,1.9))*sc;
            var wd = step*un(0.48,0.68)*(0.65 + 0.35*sc);
            out.push(oneStroke(jx, jy, ang, ln, wd, 0.35, 0.02, 4, 'block', true, null));
          }
        }
        x += step;
      }
      y += step;
    }
    return humanOrder(out);
  }

  /* ---- 层 3：细节短笔 ---- */
  function layer3(){
    var step = 4.2*u, cands = [], y = step*0.5;
    while (y < H){
      var x = step*0.5;
      while (x < W){
        var jx = x + (rnd()*2-1)*step*0.5, jy = y + (rnd()*2-1)*step*0.5;
        if (jx >= 0 && jx < W && jy >= 0 && jy < H){
          var d = detAt(jx,jy);
          if (d > 0.12){
            var ang = flowDir(jx, jy, 0.16);
            var ln = un(4.5,10.0)*(1 + Math.min(d,1.2)*0.25);
            var wd = un(1.4,2.5)*Math.max(0.7, u);
            cands.push([ d*d, oneStroke(jx, jy, ang, ln, wd, 0.8, 0.03, 3, 'fine', true, null) ]);
          }
        }
        x += step;
      }
      y += step;
    }
    var n = clamp(Math.round(cands.length*0.26), 300, 2800);
    var out = humanOrder(subsample(cands, n));
    return { strokes: out, cand: cands.length };
  }

  /* ---- 层 4：五官 / 高细节 ROI 加密 ---- */
  function findRois(count){
    var ii = integral(detail, W, H), best = [];
    var rMin = clamp(78*u, 18, Math.min(W,H)*0.16);
    var rMax = clamp(112*u, 26, Math.min(W,H)*0.24);
    for (var round = 0; round < count; round++){
      var r = rMin + (rMax-rMin)*rnd();
      var ri = Math.max(2, Math.round(r));
      var bestScore = -1, bx = 0, by = 0;
      for (var y = ri; y < H-ri; y += 2){
        for (var x = ri; x < W-ri; x += 2){
          var x0 = Math.max(0, x-ri), x1 = Math.min(W, x+ri);
          var y0 = Math.max(0, y-ri), y1 = Math.min(H, y+ri);
          var s = ii[y1*(W+1)+x1] - ii[y0*(W+1)+x1] - ii[y1*(W+1)+x0] + ii[y0*(W+1)+x0];
          var area = (y1-y0)*(x1-x0);
          var score = s/area;
          var ok = true;
          for (var q = 0; q < best.length; q++){
            var ddx = x-best[q][0], ddy = y-best[q][1];
            if (Math.hypot(ddx,ddy) < best[q][2] + ri*0.9){ ok = false; break; }
          }
          if (ok && score > bestScore){ bestScore = score; bx = x; by = y; }
        }
      }
      if (bestScore < 0.05) break;
      best.push([bx, by, ri, bestScore]);
    }
    return best;
  }
  function layer4(rois){
    var step = 1.7*u, out = [];
    rois.forEach(function(ro){
      var rcx = ro[0], rcy = ro[1], rr = ro[2], strokes = [];
      var y = rcy - rr;
      while (y < rcy + rr){
        var x = rcx - rr;
        while (x < rcx + rr){
          var jx = x + (rnd()*2-1)*step*0.5, jy = y + (rnd()*2-1)*step*0.5;
          if (jx >= 0 && jx < W && jy >= 0 && jy < H){
            if ((jx-rcx)*(jx-rcx) + (jy-rcy)*(jy-rcy) <= rr*rr){
              var d = detAt(jx,jy);
              if (d > 0.08 || rnd() < 0.4){
                var ang = flowDir(jx, jy, 0.13);
                var ln = un(3.6,8.5)*(1 + Math.min(d,1)*0.2);
                var wd = un(1.8,3.2)*Math.max(0.75, u);
                strokes.push([ 0.3 + Math.pow(d,1.4),
                               oneStroke(jx, jy, ang, ln, wd, 0.7, 0.03, 3, 'fine', true, null) ]);
              }
            }
          }
          x += step;
        }
        y += step;
      }
      var n = clamp(Math.round(strokes.length*0.20), 160, 1300);
      var picked = humanOrder(subsample(strokes, n));
      out = out.concat(picked);
    });
    return out;
  }

  /* ---- 光栅化：把已经画好的笔触画到分析分辨率的小画布上，用来和原图逐像素比 ---- */
  var raster = null;
  function rasterInit(){
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var cx = cv.getContext('2d', {willReadFrequently:true});
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
    cx.lineCap = 'round'; cx.lineJoin = 'round';
    raster = { cx: cx, done: 0 };
  }
  function rasterFeed(list){
    var cx = raster.cx, i, q;
    for (i = raster.done; i < list.length; i++){
      var s = list[i], pts = s.p;
      cx.strokeStyle = s.c; cx.fillStyle = s.c;
      var w2 = Math.max(1, s.w/k);
      cx.lineWidth = w2;
      if (pts.length < 4){
        cx.beginPath(); cx.arc(pts[0]/k, pts[1]/k, w2*0.5, 0, 6.2832); cx.fill();
        continue;
      }
      cx.beginPath(); cx.moveTo(pts[0]/k, pts[1]/k);
      for (q = 2; q < pts.length; q += 2) cx.lineTo(pts[q]/k, pts[q+1]/k);
      cx.stroke();
    }
    raster.done = list.length;
    return raster.cx.getImageData(0, 0, W, H).data;
  }

  /* ---- 层：误差修整 —— 画完和原图逐像素比对，差最大的格子补笔（画面糊就是这一步治的） ---- */
  function refinePass(prev, cell, budget, thin){
    var img = rasterFeed(prev);
    var cands = [], y, x, by, bx, gi, oi, se, n1, y1, x1, ro, err;
    for (y = 0; y < H; y += cell){
      y1 = Math.min(H, y + cell);
      for (x = 0; x < W; x += cell){
        x1 = Math.min(W, x + cell);
        se = 0; n1 = 0;
        for (by = y; by < y1; by++){
          ro = by*W;
          for (bx = x; bx < x1; bx++){
            gi = ro + bx; oi = gi*4;
            se += 0.3*Math.abs(img[oi]   - R[gi]*255)
                + 0.59*Math.abs(img[oi+1] - G[gi]*255)
                + 0.11*Math.abs(img[oi+2] - B[gi]*255);
            n1++;
          }
        }
        err = n1 ? se/n1 : 0;
        // 阈值别太低：太低会去追 JPEG 噪点和笔触自身的抗锯齿，越修越脏
        if (err > 9) cands.push([ Math.pow(err, 1.5), [x + cell*0.5, y + cell*0.5] ]);
      }
    }
    if (!cands.length) return [];
    var picked = subsample(cands, budget), out = [];
    for (var i = 0; i < picked.length; i++){
      var cx2 = picked[i][0] + (rnd()*2-1)*cell*0.35;
      var cy2 = picked[i][1] + (rnd()*2-1)*cell*0.35;
      if (cx2 < 0 || cx2 >= W || cy2 < 0 || cy2 >= H) continue;
      var ang = flowDir(cx2, cy2, 0.12);
      // 边缘处用更细的笔，避免把轮廓糊掉；平坦处才敢用宽笔
      var ed = edge[idxAt(cx2, cy2)];
      var wmul = (thin || 1) * (1 - 0.55*Math.min(1, ed*1.6));
      // 粗修那几轮用轻微混合色（避免一块一块的色斑），最后两轮才用原像素色
      var md = (thin && thin < 0.8) ? 'raw' : 'fine';
      out.push(oneStroke(cx2, cy2, ang, cell*un(1.6, 2.6)*wmul + cell*0.5,
                         cell*un(0.85, 1.15)*wmul,
                         0.45, 0.02, 3, md, true, null));
    }
    return humanOrder(out);
  }

  /* ---- 层：补缝（光栅化后仍空着的纸缝，用邻近颜色补上） ---- */
  function layerPatch(prev){
    var img = rasterFeed(prev);
    var cell = Math.max(4, Math.round(7*u)), out = [], tot = 0;
    for (var yy = 0; yy < H; yy += cell){
      for (var xx = 0; xx < W; xx += cell){
        var un5 = 0, n2 = 0;
        for (var by = yy; by < Math.min(H, yy+cell); by++){
          for (var bx = xx; bx < Math.min(W, xx+cell); bx++){
            n2++; if (img[(by*W+bx)*4+3] < 128) un5++;
          }
        }
        tot++;
        if (n2 && un5/n2 > 0.25){
          var cx2 = xx + cell*0.5 + (rnd()*2-1)*2;
          var cy2 = yy + cell*0.5 + (rnd()*2-1)*2;
          var ang2 = flowDir(cx2, cy2, 0.35);
          out.push(oneStroke(cx2, cy2, ang2, cell*un(1.2,1.8), cell*un(0.9,1.25),
                             0.4, 0.02, 3, 'raw', false, null));
        }
      }
    }
    return humanOrder(out);
  }

  /* ---- 层 6：墨线收边 ---- */
  function layer6(){
    var step = 2.4*u, cands = [], y = step*0.5;
    var local = boxBlur(lum, W, H, Math.max(1,Math.round(4*u)), 2);
    while (y < H){
      var x = step*0.5;
      while (x < W){
        var jx = x + (rnd()*2-1)*step*0.5, jy = y + (rnd()*2-1)*step*0.5;
        if (jx >= 0 && jx < W && jy >= 0 && jy < H){
          var q3 = idxAt(jx,jy);
          if ((lum[q3] < local[q3]-0.045 && edge[q3] > 0.18) || lum[q3] < 0.16){
            var ang = flowDir(jx, jy, 0.07);
            var w = 0.1 + edge[q3]*edge[q3];
            cands.push([ w, oneStroke(jx, jy, ang, un(3.0,7.5), un(0.8,1.6),
                                      0.5, 0.015, 3, 'raw', true, null) ]);
          }
        }
        x += step;
      }
      y += step;
    }
    var n = clamp(Math.round(cands.length*0.34), 400, 2800);
    var out = humanOrder(subsample(cands, n));
    return { strokes: out, cand: cands.length };
  }

  /* ---- 组装 + 时间轴 ---- */
  var WMUL = {1:0.45, 2:0.70, 3:1.10, 4:1.15, 5:1.0, 6:1.05, 7:1.1, 8:1.2, 9:1.1, 10:2.4};
  function assignTimes(list){
    var ws = list.map(function(s){
      var L = 0;
      for (var q = 2; q < s.p.length; q += 2) L += Math.hypot(s.p[q]-s.p[q-2], s.p[q+1]-s.p[q-1]);
      return Math.pow(L, 0.86) * (1 + 0.0035*s.w) * (WMUL[s.ln] || 1);
    });
    var tot = 0, q4;
    for (q4 = 0; q4 < ws.length; q4++) tot += ws[q4];
    var target = clamp(list.length*15, 80000, 600000);
    var dur = new Array(list.length);
    for (q4 = 0; q4 < list.length; q4++) dur[q4] = Math.max(7, target*ws[q4]/tot);

    /* 提笔换位：两笔之间离得远，就留一点"抬手 + 找位置"的时间，节奏才像人画的。
       总量封顶在基础时长的 10%，免得整段被拖慢。 */
    var diag = Math.hypot(W*k, H*k), base = 0, liftSum = 0, q5;
    for (q5 = 0; q5 < dur.length; q5++) base += dur[q5];
    var lifts = new Array(list.length);
    for (q4 = 1; q4 < list.length; q4++){
      var pa = list[q4-1], pb = list[q4];
      var ddx = pb.p[0] - pa.p[pa.p.length-2], ddy = pb.p[1] - pa.p[pa.p.length-1];
      var dist = Math.hypot(ddx, ddy);
      lifts[q4] = 0;
      if (dist > diag*0.06){
        lifts[q4] = clamp(dist/diag*380, 25, 110);
        liftSum += lifts[q4];
      }
    }
    var liftK = liftSum > base*0.10 ? (base*0.10)/liftSum : 1;
    for (q4 = 1; q4 < list.length; q4++) if (lifts[q4]) dur[q4-1] += lifts[q4]*liftK;

    var t = 0;
    for (q4 = 0; q4 < list.length; q4++){
      list[q4].t = Math.round(t); list[q4].d = Math.round(dur[q4]*10)/10;
      t += dur[q4];
    }
    return Math.round(t);
  }

  var strokes = [], bounds = [];
  function pushLayer(no, name, arr){
    if (!arr.length) return;
    for (var q = 0; q < arr.length; q++) arr[q].ln = no;
    bounds.push([no, name, strokes.length, strokes.length + arr.length]);
    strokes = strokes.concat(arr);
  }

  var rois = findRois(4).filter(function(ro){
    return ro[3] > Math.max(0.05, meanDetail*0.85);
  });
  A.rois = rois;

  onStage('生成笔触 · 铺底大笔', 30);
  pushLayer(1, '铺底大笔', layer1());
  onStage('生成笔触 · 中景长笔', 48);
  pushLayer(2, '中景长笔', layer2());
  onStage('生成笔触 · 细节短笔', 62);
  pushLayer(3, '细节短笔', layer3().strokes);
  onStage('生成笔触 · 五官加密', 70);
  pushLayer(4, '五官加密', layer4(rois));

  // 三轮误差修整：由粗到细，专补"看起来糊"的地方
  rasterInit();
  var passes = [
    [5, '修整 · 粗补', 4.0, 6200, 1.00],
    [6, '修整 · 细修', 3.0, 4600, 0.90],
    [7, '修整 · 压实', 2.3, 3400, 0.75],
    [8, '修整 · 收尾', 1.8, 2600, 0.55]
  ];
  for (var pi = 0; pi < passes.length; pi++){
    onStage('误差修整 · 第 ' + (pi+1) + ' 轮', 74 + pi*5);
    pushLayer(passes[pi][0], passes[pi][1],
              refinePass(strokes, Math.max(2, Math.round(passes[pi][2]*u)),
                         passes[pi][3], passes[pi][4]));
  }
  onStage('补缝补色', 95);
  pushLayer(9, '补缝补色', layerPatch(strokes));
  onStage('墨线收边', 97);
  pushLayer(10, '墨线收边', layer6().strokes);
  onStage('整理时间轴', 98);

  var total = assignTimes(strokes);

  /* 打包成紧凑数组：[w, t, d, color, x0,y0, x1,y1, ...] */
  var packs = strokes.map(function(s){
    var a = [s.w, s.t, s.d, s.c];
    for (var q = 0; q < s.p.length; q++) a.push(s.p[q]);
    return a;
  });
  var roiOut = rois.map(function(ro){
    return [ Math.round(ro[0]*k*10)/10, Math.round(ro[1]*k*10)/10, Math.round(ro[2]*k*10)/10 ];
  });
  return { w: W0, h: H0, total: total, rois: roiOut, layers: bounds, s: packs };
}

export { analyze, analysisSize };
