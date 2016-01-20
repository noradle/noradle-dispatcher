#!/usr/bin/env node

/**
 * Created by kaven276@vip.sina.com on 15-5-18.
 * dispatcher is a frame switcher who provide dynamic virtual connection for client request and oracle response
 * design principle: simple, robust, stable long running
 *
 * usage:
 * require('noradle').dispatcher.start({
 *   listen_port: the port to listen for oracle reversed connections, client connections, and monitor connections,
 *   keep_alive_interval: number of seconds to send keep_alive frame to oracle,
 *   client_config: the path client configuration file is located on
 *   db: {
 *     ... as session db to check oracle connection is from right db
 * }
 *
 * or use command line
 * dispatcher --listen_port=xxx keep_alive_interval=xxx client_config=xxx
 *
 * functions:
 * 1. check and hold oracle reversed connections, keep-alive to oracle
 * 2. authenticate and hold client connections
 * 3. establish/destroy virtual connections from client to oracle process
 * 4. assign concurrency to clients statically and dynamically
 * 5. collect/provide current/accumulative statistics
 *
 * variable explain:
 * oSlotID : global oracle slot id
 * cSlotID : local to one client connection
 * freeOraSlotIDs : all free oracle slot IDs, more recently used at head, new added at tail
 * clients[cseq].cSlots[cSlotID] = { oSlotID: number, buf: frames }
 * oraSessions[oSlotID] = {cSeq: number, cSlotID: number, cSock: socket}
 * queue[n] = [cSeq, cSlotID]
 */
"use strict";

function Stats(){
  this.reqCount = 0;
  this.respCount = 0;
  this.waitTime = 0;
  this.respDelay = 0;
  this.execTime = 0;
  this.inBytes = 0;
  this.outBytes = 0;
}

var net = require('net')
  , fs = require('fs')
  , frame = require('noradle-protocol').frame
  , _ = require('underscore')
  , C = require('noradle-protocol').constant
  , queue = []
  , clients = new Array(C.MAX_CLIENTS)
  , clientsHW = 0
  , oraSessions = new Array(C.ORA_MAX_SLOTS)
  , oraSessionsHW = 0
  , freeOraSlotIDs = []
  , gConnSeq = 0
  , oSlotCnt = 0
  , concurrencyHW = 0
  ;

var debug = require('debug')
  , logLifeCycle = debug('dispatcher:lifecycle')
  , logDispatch = debug('dispatcher:dispatch')
  , logMan = debug('dispatcher:man')
  , logGrace = debug('dispatcher:grace')
  ;

_.each(client_cfgs, function(v, n){
  v.stats = new Stats();
});

function Client(c, cSeq, cid){
  this.cTime = Date.now();
  this.socket = c;
  this.cSeq = cSeq;
  this.cid = cid;
  this.cSlots = new Array(C.CLI_MAX_SLOTS);
  var cfg = client_cfgs[cid];
  this.cur_concurrency = 0;
  this.cfg = cfg;
}

function bindOSlot(req, cSeq, cSlotID, cTime, oSlotID){
  req.oSlotID = oSlotID;
  var oraSlot = oraSessions[oSlotID];
  oraSlot.cType = C.NORADLE;
  oraSlot.cSeq = cSeq;
  oraSlot.cSlotID = cSlotID;
  oraSlot.cTime = cTime;
}

function findMinFreeCSeq(){
  for (var i = 1; i < clientsHW; i++) {
    if (!clients[i]) return i;
  }
  return clientsHW++;
}

function parseNVArray(arr){
  var o = {};
  for (var i = 0, len = arr.length; i < len; i += 2) {
    o[arr[i]] = arr[i + 1];
  }
  return o;
}

// may accept from different front nodejs connection request
exports.serveClient = function serveClient(c, cid){
  var cSeq = findMinFreeCSeq()
    , client = clients[cSeq] = new Client(c, cSeq, cid)
    , cStats = client.cfg.stats
    ;

  logLifeCycle('node(%d) connected', cSeq);
  // got client concurrency quota from oracle
  // send cid,cSeq to oracle, require cid's conncurrency quota
  // initial set to 0, donn't need to send it, client' initial freelist is []
  // when oracle return quota, call below to signal client he have this number of concurrency
  (function getClientConfig(){
    getFreeOSlot(function(oSlotID, oSock){
      var arr = ['CLI_CFG', '', 'm$cid', client.cid, 'm$cseq', client.cSeq];
      logMan('fetchClientConfig send %j', arr);
      toOracle(oSock, arr);
      afterNewAvailableOSlot(oSlotID, false);
    });
  })();

  c.on('end', function(){
    c.end();
    logLifeCycle('node(%d) disconnected', cSeq);
  });

  c.on('error', function(err){
    console.error('client socket error', err, cSeq);
    delete clients[cSeq];
  });

  c.on('close', function(has_error){
    logLifeCycle('client(%d) close', cSeq);
    delete clients[cSeq];
  });

  frame.parseFrameStream(c, function processClientFrame(head, cSlotID, type, flag, len, body){
    logDispatch('C2O: cSlotID=%d type=%d len=%d', cSlotID, type, len);
    if (cSlotID === 0) {
      req = JSON.parse(body);
      switch (type) {
        case 0:
          // authentication, check clientid, passcode
          break;
        case 1:
          // tell pending queue length
          break;
        case 255:
        // graceful quit
        default:
          ;
      }
      return;
    }

    // it's for normal request frame
    var req, oSlotID, oSock;

    cStats.inBytes += (8 + len);
    if (type === C.HEAD_FRAME) {
      var body0 = new Buffer(['NORADLE', client.cid, cSlotID].join(','))
        , head0 = frame.makeFrameHead(cSlotID, C.PRE_HEAD, 0, body0.length)
        ;
      cStats.reqCount++;
      req = client.cSlots[cSlotID] = {
        rcvTime : Date.now(),
        buf : [head0, body0, head, body]
      };
      getFreeOSlot(function(oSlotID, oSock){
        oSock.write(Buffer.concat(req.buf));
        delete req.buf;
        bindOSlot(req, cSeq, cSlotID, client.cTime, oSlotID);
        req.sendTime = Date.now();
        logDispatch('C2O: (%d,%d) found oSlot to send', cSlotID, oSlotID);
      });
    } else {
      req = client.cSlots[cSlotID];
      // for the successive frames of a request
      oSlotID = req.oSlotID;
      if (oSlotID) {
        logDispatch('C2O: (%d,%d) successive frame use bound oSlodID(%d)', cSlotID, oSlotID);
        oSock = oraSessions[oSlotID].socket;
        oSock.write(head);
        body && oSock.write(body);
      } else {
        logDispatch('C2O: cSlodID(%d,_) successive frame add to buf(chunks=%d)', cSlotID, req.buf.length);
        req.buf.push(head);
        body && req.buf.push(body);
      }
    }
  });
};

function Session(headers, socket){

  oSlotCnt++;
  this.headers = headers;

  var session = {
    sid : parseInt(headers['x-sid']),
    serial : parseInt(headers['x-serial']),
    spid : parseInt(headers['x-spid']),
    age : parseInt(headers['x-age']),
    reqs : parseInt(headers['x-reqs']),
  };

  var db = {
    name : headers['x-db_name'],
    domain : headers['x-db_domain'],
    unique : headers['x-db_unique_name'],
    con_name : headers['x-con_name'],
    role : headers['x-database_role'],
    inst : parseInt(headers['x-instance']),
    cfg_id : headers['x-cfg_id']
  };

  // fixed properties
  this.slotID = parseInt(headers['x-oslot_id']);
  this.session = session;
  this.db = db;
  this.socket = socket;

  // dynamic properties
  this.cSeq = null;
  this.cSlotID = null;
  this.quitting = false;

  if (this.slotID > oraSessionsHW) {
    oraSessionsHW = this.slotID;
  }
}

function getFreeOSlot(cb){
  if (freeOraSlotIDs.length > 0) {
    var oSlotID = freeOraSlotIDs.shift();
    cb(oSlotID, oraSessions[oSlotID].socket);
  } else {
    queue.push(cb);
  }
}

function afterNewAvailableOSlot(oSlotID, isNew){
  logDispatch('BUF: (%d) oSlot free (%s), queue length=%d', oSlotID, isNew ? 'newly' : 'recycled', queue.length);
  var w = queue.shift();
  if (w) {
    // tell pmon queue length
    if (queue.length + oSlotCnt > concurrencyHW) {
      signalAskOSP(oraSessions[oSlotID].socket, queue);
    }
    w(oSlotID, oraSessions[oSlotID].socket);
  } else {
    concurrencyHW = oSlotCnt;
    if (isNew) {
      freeOraSlotIDs.push(oSlotID);
    } else {
      freeOraSlotIDs.unshift(oSlotID);
    }
  }
}

function toOracle(c, arr){
  frame.writeFrame(c, 0, C.HEAD_FRAME, 0, (new Buffer(arr.join('\r\n')) + '\r\n\r\n\r\n'));
}

function signalAskOSP(c, queue){
  concurrencyHW = queue.length + oSlotCnt;
  toOracle(c, ['ASK_OSP', '', 'queue_len', queue.length, 'oslot_cnt', oSlotCnt]);
}

function signalOracleQuit(c){
  toOracle(c, ['QUIT', '']);
}

function signalOracleKeepAlive(c){
  toOracle(c, ['KEEPALIVE', '', 'keepAliveInterval', keepAliveInterval]);
}

// for oracle reverse connection
exports.serveOracle = function serveOracle(c, headers){
  var oraSession = new Session(headers, c)
    , oSlotID = oraSession.slotID
    , connSeq = ++gConnSeq
    ;
  if (!oraSession.slotID) {
    // delay signal oracle for quit, prevent oracle from repeating re-connect
    setTimeout(function(){
      signalOracleQuit(c);
    }, keepAliveInterval * 3000);
    return;
  }
  oraSessions[oSlotID] = oraSession;
  signalOracleKeepAlive(c);
  logLifeCycle('oracle seq(%s) oSlot(%s) slot add, freeListCount=%d', connSeq, oSlotID, freeOraSlotIDs.length);
  afterNewAvailableOSlot(oSlotID, true);

  c.on('end', function(){
    c.end();
    logLifeCycle('oracle seq(%s) oSlot(%s) disconnected', connSeq, oSlotID);
    // find free list and remove from free list
    var pos = freeOraSlotIDs.indexOf(oSlotID);
    if (pos >= 0) {
      // if in free list, just remove from free list
      freeOraSlotIDs.splice(pos, 1);
      logLifeCycle('oracle seq(%s) oSlot(%s) slot removed, freeListCount=%d', connSeq, oSlotID, freeOraSlotIDs.length);
    } else {
      // if in busy serving a client request, raise a error for the req
      var oSlot = oraSessions[oSlotID]
        , cSlotID = oSlot.cSlotID
        , client = clients[oSlot.cSeq || 0]
        ;
      if (client && oSlot.cTime === client.cTime) {
        logLifeCycle('busy oSlot(%s) slot socket end, cSeq(%s,%d), cSlotid(%d)', oSlotID, client.cid, oSlot.cSeq, cSlotID);
        frame.writeFrame(client.socket, cSlotID, C.ERROR_FRAME, 0, 'oracle connection break!');
        frame.writeFrame(client.socket, cSlotID, C.END_FRAME, 0);
        delete client.cSlots[cSlotID];
      }
    }
    delete oraSessions[oSlotID];
    oSlotCnt--;
  });

  c.on('error', function(err){
    logLifeCycle('oracle[%d] socket error: %s', oSlotID, err);
    delete oraSessions[oSlotID];
    oSlotCnt--;
    // todo: may release resource
  });

  frame.parseFrameStream(c, function processOracleFrame(head, cSlotID, type, flag, len, body){
    (cSlotID ? handleOracleApplicationFrame : handleOracleManagementFrame)();

    function handleOracleManagementFrame(){
      // control frame from oracle
      switch (type) {
        case C.RO_QUIT:
          (function gotOracleQuitting(oSlotID){
            // oracle want to quit, if oSlot is free then quit, otherwise make oSlot is quitting, quit when release
            oraSessions[oSlotID].quitting = true;
            var index = freeOraSlotIDs.indexOf(oSlotID);
            if (index >= 0) {
              freeOraSlotIDs.splice(index, 1);
              signalOracleQuit(c);
            }
          })(oSlotID);
          return;
        case C.RES_CLI_CFG:
          (function gotClientConfig(body){
            var cfg = parseNVArray(body.toString().split("\0"))
              , cSeq = parseInt(cfg.cseq)
              , client = clients[cSeq]
              , c = client.socket
              ;
            logMan('fetchClientConfig got %j', cfg);
            client.cur_concurrency = parseInt(cfg.min_concurrency);
            client.cfg.min_concurrency = parseInt(cfg.min_concurrency);
            client.cfg.max_concurrency = parseInt(cfg.max_concurrency);
            frame.writeFrame(c, 0, C.SET_CONCURRENCY, 0, JSON.stringify(client.cur_concurrency));
          })(body);
          return;
        default:
          logMan('unknown management frame %j', body.toString().split('\0'));
      }
    }

    function handleOracleApplicationFrame(){
      // redirect frame to the right client socket untouched
      var oraSession = oraSessions[oSlotID];
      logDispatch('O2%s: (%d,%d), type=%d', 'CHSF'[oraSession.cType], cSlotID, oSlotID, type);
      switch (oraSession.cType) {
        case C.NORADLE:
          var client = clients[oraSession.cSeq];
          // client may be killed this time or a client with same cSeq connected
          if (client && oraSession.cTime === client.cTime) {
            var cliSock = client.socket;
            cliSock.write(head);
            body && cliSock.write(body);

            var cStats = client.cfg.stats
              , req = client.cSlots[cSlotID]
              ;
            cStats.outBytes += (8 + len);
            if (type === C.HEAD_FRAME) {
              cStats.respDelay += (Date.now() - req.sendTime);
            }
            if (type === C.END_FRAME) {
              cStats.respCount++;
              cStats.waitTime += (req.sendTime - req.rcvTime);
              cStats.execTime += (Date.now() - req.sendTime);
              delete client.cSlots[cSlotID];
            }
          } else {
            // requesting client is gone
          }
          if (type === C.END_FRAME) {
            // reclaim oraSock for other use
            logDispatch('O2C: (%d,%d) oSlot is freed', cSlotID, oSlotID);
          }
          break;
      }
      if (type === C.END_FRAME) {
        if (oraSession.quitting) {
          signalOracleQuit(c);
        } else {
          afterNewAvailableOSlot(oSlotID, false);
        }
      }
    }
  });
};

/**
 * for keep-alive to oracle
 * dispatcher is usually deployed with oracle database at the same server or same LAN,
 * so normally keep-alive is not required
 * but when they are connected throuth NAT, keep-alive is required to detect a NAT state lost.
 * OPS will quit after idle_timeout seconds
 * dispatcher will treat oSlot as lost connection when keep-alive request have no reply
 * oracle will send keep-alive frame
 * every n seconds, dispatcher send free oSlot a keep-alive frame
 * OPS wait over n seconds, no frame is arrived, OPS detect lost connection, then re-connect
 * n value is send with keep-alive setting frame from dispatcher to OPS when first connected or value is changed
 * if n+3 s, no pong frame received, dispatcher detect lost connection, then release oSlot
 * If firewall suddenly restart, dispatcher/OPS can both detect lost connection
 */

(function setKeepAlive(){
  setInterval(function(){
    freeOraSlotIDs.forEach(function(oSlotID){
      signalOracleKeepAlive(oraSessions[oSlotID].socket);
    });
  }, keepAliveInterval * 1000);
})();

var monServices = {
  getStartConfig : function(cb){
    cb(startCfg);
  },
  getClientConfig : function(cb){
    cb(client_cfgs);
  },
  getOraSessions : function(cb){
    var oraSessions2 = new Array(oraSessionsHW);
    for (var i = 0; i < oraSessionsHW; i++) {
      if (oraSessions[i + 1]) {
        oraSessions2[i] = _.pick(oraSessions[i + 1], 'slotID', 'cSeq', 'cSlotID', 'quitting');
      }
    }
    cb(oraSessions2);
  },
  getClients : function(cb){
    var clients2 = {};
    for (var i = 0; i < clientsHW; i++) {
      var client = clients[i];
      if (client) {
        var client2 = _.clone(client);
        delete client2.socket;
        var cSlots = client2.cSlots = {};
        _.each(client.cSlots.slice(0, client.cur_concurrency + 1), function(cSlot, cSlotID){
          if (!cSlot) return;
          cSlots[cSlotID] = _.omit(cSlot, 'buf');
        });
        clients2[i] = client2;
      }
    }
    cb(clients2);
  }
};

exports.serveConsole = function(req, res){
  // it's just a rest service, route by url.path
  var serviceName = req.url.substr(1)
    , service = monServices[serviceName]
    ;
  if (!service) {
    res.writeHead(404, {'Content-Type' : 'text/plain'});
    res.end('no such service ' + serviceName);
    return;
  }
  service(function(data){
    var body = JSON.stringify(data);
    res.writeHead(200, {
      'Content-Type' : 'application/json',
      'Content-Length' : (new Buffer(body)).length
    });
    res.end(body);
  });
};

// graceful quit support
// stop listen and wait all pending request to finish
// after 1 minute, force quit any way
process.on('SIGTERM', function gracefulQuit(){
  logGrace('SIGTERM received, new connection/request is not allowed, when all request is done, process will quit safely');

  // no more client/oracle/monitor can connect to me
  exports.server4all.close(function(){
    logGrace('all client/oracle/monitor connections is closed, safe to quit');
    process.exit(0);
  });

  // send quit signal to every client to close connection
  for (var i = 0; i < clientsHW; i++) {
    var client = clients[i];
    client && frame.writeFrame(client.socket, 0, C.WC_QUIT, 0);
  }

  // send quit signal to every free oracle connection
  for (var i = 1; i <= oraSessionsHW; i++) {
    var oSlot = oraSessions[i];
    if (oSlot) {
      oSlot.quitting = true;
      var index = freeOraSlotIDs.indexOf(i);
      if (index >= 0) {
        freeOraSlotIDs.splice(index, 1);
        signalOracleQuit(oraSessions[i].socket);
      }
    }
  }

  setInterval(function(){
    exports.server4all.getConnections(function(err, count){
      logGrace('remain %d connections on server', count);
    });
  }, 1000);

  // anyway, force quit after 1 minute
  setTimeout(function(){
    process.exit(1);
  }, 15 * 1000);
});

process.on('SIGUSER2', function reloadConfig(){
  // reload configuration
});

