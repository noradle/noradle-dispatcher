var debug = require('debug')
  , fs = require('fs')
  , frame = require('noradle-protocol').frame
  , main = require('./dispatch.js')
  , logRequest = debug('dispatcher:onRequest')
  , logUpgrade = debug('dispatcher:onUpgrade')
  ;

// todo : secure client authenticate
// may support dynamic client auth with database
// or use dynamic cfg file that can be updated at runtime
// then can be CHAP code later to protect password transfer
// dispatcher give a random code
// client send md5(passwd+random) back to dispatcher to test

var extract = (function(){
  var auth = require('basic-auth');
  return function extract(req){
    var tmp = auth(req) || {name : '', pass : ''}
      , upgrade = !!req.headers.upgrade
      , byProxy = !!req.headers["x-forwarded-proto"]
      ;
    var authAttr = {
      role : req.headers['x-noradle-role'] || (upgrade ? 'console' : ''),
      name : tmp.name,
      pass : tmp.pass,
      cip : byProxy ? '0.0.0.0' : req.socket.remoteAddress,
      secure : !!(byProxy ? req.headers["x-forwarded-proto"].match(/(wss|https)/) : req.connection.encrypted)
    };
    (upgrade ? logUpgrade : logRequest)(authAttr);
    return authAttr;
  };
})();

function serveConsole(req, res){
  logRequest('client normal request arrived, it must be from noradle-console');
  logRequest('req.url=%s', req.url);
  logRequest('req.headers=%s', JSON.stringify(req.headers, null, 2));
  authAttr = extract(req);
  if (authAttr.role !== 'console') {
    res.writeHead(401, {'Content-Type' : 'text/plain'});
    res.write('only noradle-console is allowed to access');
    res.end();
    logRequest('role!==console');
    return;
  }
  // todo: check console name:pass:ip for every request, no state here
  if (demoCheck(authAttr)) {
    res.writeHead(401, {
      'WWW-authenticate' : 'Basic realm="DISPATCHER"',
      'Content-Type' : 'text/plain'
    });
    res.write('you are not allowed');
    res.end();
    logRequest('user:pass:ip check failed');
    return;
  }
  logRequest('%s passed authorization check, serve it', authAttr.role);
  main.serveConsole(req, res);
}

function serveClientOracle(req, cltSocket, head){
  // connect to an origin server
  logUpgrade('client|oracle upgrade request arrived (secure=%s)', !!cltSocket.encrypted);
  logUpgrade('req.headers=%s', JSON.stringify(req.headers, null, 2));

  // ensure the client init request can pass through proxy(support websocket relay) to noradle dispatcher
  if (req.method === 'GET' && (req.headers.upgrade || '').toLowerCase() === 'websocket') ; else {
    socket.destroy();
    return true;
  }

  var authAttr = extract(req);
  if (demoCheck(authAttr)) {
    cltSocket.end('HTTP/1.1 401 Forbidden\r\n' +
      'WWW-Authenticate: Basic realm="example"\r\n' +
      '\r\n');
    return;
  }

  var response = [
    'HTTP/1.1 101 Switching Protocols',
    'Connection: Upgrade',
    'Upgrade: websocket',
    '',
    ''
  ].join('\r\n');

  cltSocket.write(response);
  logUpgrade('%s passed authorization check, connected', authAttr.role);

  // established socket/tunnel have no timeout setting, live forever, check cltSocket._idleTimeout
  cltSocket.setTimeout(0);

  switch (authAttr.role) {
    case 'client':
      // process frame
      // fakeTCPServer(cltSocket);
      main.serveClient(cltSocket, authAttr.name);
      break;
    case 'oracle':
      // register in dbPools
      main.serveOracle(cltSocket, req.headers);
      break;
    default:
      // fake service for every on.data data
      fakeTCPServer(cltSocket);
  }
}

(function startServer(){

  var http = require('http')
  http.createServer()
    .on('request', serveConsole)
    .on('upgrade', serveClientOracle)
    .on('connection', function(){
      console.log('new http connection to dispatcher');
    }).listen(startCfg.listen_port, function(){
      console.log('dispatcher is listening at %d for http', startCfg.listen_port);
    });

  var httpsCfg = gConfig.https;
  if (!httpsCfg) return;

  var https = require('https')
    , pem = httpsCfg.pem
    , lAddr = httpsCfg.listen
    ;
  try {
    var pem = {
      key : fs.readFileSync(pem.keyFile),
      cert : fs.readFileSync(pem.certFile)
    };
    lAddr.port = lAddr.port || 1523;
    lAddr.host = lAddr.host || '0.0.0.0';
    https.createServer(pem)
      .on('request', serveConsole)
      .on('upgrade', serveClientOracle)
      .on('connection', function(){
        console.log('new https connection to dispatcher');
      }).listen(lAddr.port, lAddr.host, function(){
        console.log('dispatcher is listening at %s:%d for https', lAddr.host, lAddr.port);
      });
  } catch (e) {
    console.error('https can not started, %j', e)
  }
})();

function fakeTCPServer(cltSocket){
  cltSocket.setEncoding('utf8');
  cltSocket.on('data', function(data){
    dlog('received (%s)', data);
    cltSocket.write('a response frame');
  });
  cltSocket.on('end', function(){
    dlog('client disconnect');
    cltSocket.end();
  });
}

/**
 * check if client is allowed to access dispatcher service
 * by default, use a configuration file
 * @param role
 * @param user
 * @param pass
 * @param cip
 * @param secure
 * @returns {boolean} false:pass, any_string:error_type
 */
function check(authAttr){
  return true;
}

function demoCheck(p){
  return false;
  switch (p.role) {
    case 'console':
      return !(p.name === 'admin' && p.pass === 'noradle');
      break;
    case 'client':
      if (p.name === 'demo' && p.pass !== 'demo') {
        return 'pass';
      }
      if (p.name === 'demo' && p.cip !== '127.0.0.1') {
        return 'ip';
      }
      return false;
    case 'oracle':
      return false;
      break;
  }
  return true;
}

function checkByConfig(configPath){
  var cfg = require(configPath);
  return function check(authAttr){
    // check according to config rules
    return true;
  }
}

