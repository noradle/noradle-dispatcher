var debug = require('debug')
  , frame = require('noradle-protocol').frame
  , main = require('./dispatch.js')
  , logRequest = debug('dispatcher:onRequest')
  , logUpgrade = debug('dispatcher:onUpgrade')
  ;

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
      byProxy : byProxy,
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
  authAttr.role = 'console';
  if (authAttr.role !== 'console') {
    res.writeHead(401, {'Content-Type' : 'text/plain'});
    res.write('only noradle-console is allowed to access');
    res.end();
    logRequest('role!==console');
    return;
  }
  // todo: check console name:pass:ip for every request, no state here
  if (global.authChecker(authAttr)) {
    res.writeHead(401, {
      'WWW-authenticate' : 'Basic realm="NORADLE"',
      'Content-Type' : 'text/plain'
    });
    res.write('you are not allowed');
    res.end();
    logRequest('user:pass:ip:secure check failed');
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

  if (!authAttr.role.match(/^(client|oracle)$/)) {
    cltSocket.end('HTTP/1.1 401 Forbidden\r\n' +
      'WWW-Authenticate: Basic realm="NORADLE"\r\n' +
      '\r\n');
    return;
  }

  var reason;
  if (reason = global.authChecker(authAttr)) {
    logUpgrade('%s authorization failed check, %s', authAttr.role, reason);
    cltSocket.end('HTTP/1.1 401 Forbidden\r\n' +
      'WWW-Authenticate: Basic realm="NORADLE"\r\n' +
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
      // receive client requests
      main.serveClient(cltSocket, authAttr.name);
      break;
    case 'oracle':
      // register oracle connections in dbPools
      main.serveOracle(cltSocket, req.headers);
      break;
  }
}

/**
 * usage: bindServer(http.createServer()).listen
 */
function bindServer(server){
  return server
    .on('request', serveConsole)
    .on('upgrade', serveClientOracle)
    .on('connection', function(c){
      console.log('new connection to dispatcher(%s:%d)', c.localAddress, c.localPort);
    });
}
exports.bindServer = bindServer;

(function startServer(){

  function getOptions(listenAddr){
    var lAddr = listenAddr.split(':')
      , port = parseInt(lAddr[0])
      , host = lAddr[1]
      , options = {port : port}
      ;

    if (host && host.length === 0) {
      host = 'localhost';
    }
    if (host) {
      options.host = host;
    }
    return options;
  }

  (function listenHTTP(){
    if (!global.args.listenHttp) return;
    var o = getOptions(global.args.listenHttp);
    if (o.host) {
      bindServer(require('http').createServer()).listen(o.port, o.host, function(){
        console.log('dispatcher is listening at %s for http', global.args.listenHttp);
      });
    } else {
      bindServer(require('http').createServer()).listen(o.port, function(){
        console.log('dispatcher is listening at %s for http', global.args.listenHttp);
      });
    }
  })();

  (function listenPath(){
    if (!global.args.listenPath) return;
    bindServer(require('http').createServer()).listen(global.args.listenPath, function(){
      console.log('dispatcher is listening at %s for http', global.args.listenPath);
    });
  })();

  (function listenHttps(){
    if (!global.args.listenHttps) return;
    if (!global.args.pemPrefix) return;
    var fs = require('fs')
      , pemPrefix = global.args.pemPrefix
      ;
    try {
      var pem = {
        key : fs.readFileSync(pemPrefix + '-key.pem'),
        cert : fs.readFileSync(pemPrefix + '-cert.pem')
      };
      var o = getOptions(global.args.listenHttps);
      if (o.host) {
        bindServer(require('https').createServer(pem)).listen(o.port, o.host, function(){
          console.log('dispatcher is listening at %s for https', global.args.listenHttps);
        });
      } else {
        bindServer(require('https').createServer(pem)).listen(o.port, function(){
          console.log('dispatcher is listening at %s for https', global.args.listenHttps);
        });
      }
    } catch (e) {
      console.error('https can not started, %s', e, console.log(pemPrefix));
    }
  })();

  (function rawHTTP(){
    if (!global.args.rawHttp) return;
    var o = getOptions(global.args.rawHttp);
    var server = require('net').createServer(function(c){
      main.serveHTTP(c, 'HTTP:' + global.args.rawHttp);
    });
    if (o.host) {
      server.listen(o.port, o.host, function(){
        console.log('dispatcher is listening at %s for raw HTTP', global.args.rawHttp);
      });
    } else {
      server.listen(o.port, function(){
        console.log('dispatcher is listening at %s for raw HTTP', global.args.rawHttp);
      });
    }
  })();

  (function rawSCGI(){
    if (!global.args.rawScgi) return;
    var o = getOptions(global.args.rawScgi);
    var server = require('net').createServer(function(c){
      main.serveSCGI(c, 'SCGI:' + global.args.rawScgi);
    });
    if (o.host) {
      server.listen(o.port, o.host, function(){
        console.log('dispatcher is listening at %s for raw SCGI', global.args.rawScgi);
      });
    } else {
      server.listen(o.port, function(){
        console.log('dispatcher is listening at %s for raw SCGI', global.args.rawScgi);
      });
    }
  })();

  (function rawFCGI(){
    if (!global.args.rawFcgi) return;
    var o = getOptions(global.args.rawFcgi);
    var server = require('net').createServer(function(c){
      main.serveFCGI(c, 'FCGI:' + global.args.rawFcgi);
    });
    if (o.host) {
      server.listen(o.port, o.host, function(){
        console.log('dispatcher is listening at %s for raw FCGI', global.args.rawFcgi);
      });
    } else {
      server.listen(o.port, function(){
        console.log('dispatcher is listening at %s for raw FCGI', global.args.rawFcgi);
      });
    }
  })();

})();

/**
 * check if client is allowed to access dispatcher service
 * by default, use a configuration file
 * @param authAttr.role {string} in (client/oracle/console)
 * @param authAttr.name {string} username for client/oracle/console
 * @param authAttr.pass {string} password
 * @param authAttr.cip {string} the client ip
 * @param authAttr.secure {boolean} if connect with SSL
 * @returns {boolean} false:pass, any_string:error_message
 */
function check(authAttr){
  return false;
}
