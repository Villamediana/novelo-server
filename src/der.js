// Just enough DER to read a certificate's extensions and Android's key description.

/** One element at [offset]: its class (0 universal, 2 context), tag number, content and where the next one starts. */
export function read(buf, offset = 0) {
  if (offset + 2 > buf.length) throw new Error('der: fim inesperado');
  const first = buf[offset];
  let at = offset + 1;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b;
    do {
      if (at >= buf.length) throw new Error('der: etiqueta cortada');
      b = buf[at++];
      tag = tag * 128 + (b & 0x7f);
      if (tag > 0xffffff) throw new Error('der: etiqueta grande demais');
    } while (b & 0x80);
  }
  if (at >= buf.length) throw new Error('der: sem tamanho');
  let len = buf[at++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || at + n > buf.length) throw new Error('der: tamanho inválido');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at++];
  }
  const end = at + len;
  if (end > buf.length) throw new Error('der: conteúdo cortado');
  return { cls: first >> 6, constructed: (first & 0x20) !== 0, tag, value: buf.subarray(at, end), next: end };
}

/** The elements inside a constructed one. */
export function children(node) {
  const out = [];
  let at = 0;
  while (at < node.value.length) {
    const el = read(node.value, at);
    out.push(el);
    at = el.next;
  }
  return out;
}

export function oid(node) {
  const v = node.value;
  if (!v.length) return '';
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    n = n * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join('.');
}

/** A small INTEGER / ENUMERATED as a number. */
export function int(node) {
  let n = 0;
  for (const b of node.value.subarray(0, 6)) n = n * 256 + b;
  return n;
}

/** The content of the extension [wanted] of a certificate (DER), or null when it has none. */
export function extension(certDer, wanted) {
  const tbs = children(read(certDer))[0];
  const exts = children(tbs).find((c) => c.cls === 2 && c.tag === 3);
  if (!exts) return null;
  for (const ext of children(children(exts)[0])) {
    const parts = children(ext);
    if (oid(parts[0]) === wanted) return parts[parts.length - 1].value;
  }
  return null;
}
