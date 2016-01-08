var debug = require('debug')
  , auth = require('basic-auth')
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

function serveConsole(req, res){
  logRequest('client normal request arrived, it must be from noradle-console');
  logRequest('req.url=%s', req.url);
  logRequest('req.headers=%s', JSON.stringify(req.headers, null, 2));
  var role = req.headers['x-noradle-role'] || 'console'
    , tmp = auth(req) || {name : '', pass : ''}
    , name = tmp.name
    , pass = tmp.pass
    , ip = req.socket.remoteAddress
    ;
  if (role !== 'console') {
    res.writeHead(401, {'Content-Type' : 'text/plain'});
    res.write('only noradle-console is allowed to access');
    res.end();
    logRequest('role!==console');
    return;
  }
  logRequest('role=%s, user=%s, pass=%s, cip=%s', role, name, pass, ip);
  // todo: check console name:pass:ip for every request, no state here
  if (demoCheck('console', name, pass, ip)) {
    res.writeHead(401, {
      'WWW-authenticate' : 'Basic realm="DISPATCHER"',
      'Content-Type' : 'text/plain'
    });
    res.write('you are not allowed');
    res.end();
    logRequest('user:pass:ip check failed');
    return;
  }
  logRequest('%s passed authorization check, serve it', role);
  main.serveConsole(req, res);
}

function serveClientOracle(req, cltSocket, head){
  // connect to an origin server
  logUpgrade('client|oracle upgrade request arrived');
  logUpgrade('req.headers=%s', JSON.stringify(req.headers, null, 2));

  // ensure the client init request can pass through proxy(support websocket relay) to noradle dispatcher
  if (req.method === 'GET' && (req.headers.upgrade || '').toLowerCase() === 'websocket') ; else {
    socket.destroy();
    return true;
  }

  var role = req.headers['x-noradle-role']
    , namepass = auth(req) || {name : '', pass : ''}
    , name = namepass.name
    , pass = namepass.pass
    , ip = cltSocket.remoteAddress
    ;

  if (false && demoCheck(role, name, pass, ip)) {
    logUpgrade('role=%s, user=%s, pass=%s, cip=%s', role, name, pass, ip);
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
  logUpgrade('%s passed authorization check, connected', role);

  // established socket/tunnel have no timeout setting, live forever, check cltSocket._idleTimeout
  cltSocket.setTimeout(0);

  switch (role) {
    case 'client':
      // process frame
      // fakeTCPServer(cltSocket);
      main.serveClient(cltSocket, name);
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
 * @returns {boolean} false:pass, any_string:error_type
 */
function check(role, user, pass, cip){
  return true;
}

/**
 *
 * @param role
 * @param name
 * @param pass
 * @param cip
 * @returns {String|Boolean} String for error info, true for fail with no reason, false for ok
 */
function demoCheck(role, name, pass, cip){
  switch (role) {
    case 'console':
      return !(name === 'admin' && pass === 'noradle');
      break;
    case 'client':
      if (name === 'demo' && pass !== 'demo') {
        dlog('name:pass error');
        return 'pass';
      }
      dlog('client address = (%s)', cip);
      if (name === 'demo' && cip !== '127.0.0.1') {
        dlog('name:cip error');
        return 'ip';
      }
      dlog('name:pass:cip check pass, client is allowed');
      return false;
    case 'oracle':
      return false;
      break;
  }
  return true;
}

function checkByConfig(configPath){
  var cfg = require(configPath);
  return function check(role, user, pass, cip){
    // check according to config rules
    return true;
  }
}

