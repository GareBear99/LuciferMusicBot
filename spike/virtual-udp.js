// Virtual UDP for the spike harness.
//
// This VM's sandbox blocks outbound UDP entirely (sendto -> EPERM, even to
// 127.0.0.1 — verified with both Node dgram and Python). A real UDP socket
// can bind here, but nothing can send through it, so the voice leg cannot
// be exercised over real sockets in this environment.
//
// This module is a faithful in-process stand-in for the dgram API surface
// the voice code uses (bind / send / message / address / close), routing
// datagrams between registered ports. It proves everything above the socket
// layer: IP-discovery request/response bytes and parsing, RTP packet
// construction, encryption round-trip, sequencing, and the relay's
// forward-and-answer behaviour. The one thing it cannot prove is the OS
// socket call itself — dgram.send is standard Node, and the relay's real
// socket path is exercised for bind; the send path is identical code, just
// pointed at a real socket in production. SPIKE.md says this plainly.

export class VirtualUdpRegistry {
  constructor() {
    this.sockets = new Map();
    this.nextEphemeral = 40000;
  }

  createSocket() {
    return new VirtualUdpSocket(this);
  }

  register(port, socket) {
    this.sockets.set(port, socket);
  }

  unregister(port) {
    this.sockets.delete(port);
  }

  get(port) {
    return this.sockets.get(port);
  }

  ephemeralPort() {
    return this.nextEphemeral++;
  }
}

export class VirtualUdpSocket {
  constructor(registry) {
    this.registry = registry;
    this.handlers = new Map();
    this.localPort = 0;
    this.localAddress = '127.0.0.1';
    this.closed = false;
  }

  bind(port, host, callback) {
    if (typeof host === 'function') {
      callback = host;
      host = '127.0.0.1';
    }
    this.localPort = port || this.registry.ephemeralPort();
    this.localAddress = host || '127.0.0.1';
    this.registry.register(this.localPort, this);
    if (callback) queueMicrotask(callback);
    return this;
  }

  send(buf, port, host, callback) {
    if (typeof host === 'function') {
      callback = host;
      host = '127.0.0.1';
    }
    const dest = this.registry.get(port);
    if (!dest || dest.closed) {
      const err = new Error(`send ECONNREFUSED 127.0.0.1:${port}`);
      err.code = 'ECONNREFUSED';
      if (callback) queueMicrotask(() => callback(err));
      return;
    }
    const msg = Buffer.from(buf);
    const rinfo = { address: this.localAddress, port: this.localPort, family: 'IPv4', size: msg.length };
    queueMicrotask(() => dest.emit('message', msg, rinfo));
    if (callback) queueMicrotask(() => callback(null));
    return true;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }

  once(event, fn) {
    const wrapped = (...args) => {
      this.handlers.set(event, (this.handlers.get(event) || []).filter((f) => f !== wrapped));
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    for (const fn of this.handlers.get(event) || []) fn(...args);
  }

  address() {
    return { address: this.localAddress, family: 'IPv4', port: this.localPort };
  }

  close(callback) {
    this.closed = true;
    this.registry.unregister(this.localPort);
    if (callback) queueMicrotask(callback);
  }
}
