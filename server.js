#!/usr/bin/env node

var program = require('commander');

program
  .version(require('./package.json').version)
  .option('-H --listen-http [port:host]', 'http listening address', 1522)
  .option('-S --listen-https [port:host]', 'https listening address', 1523)
  .option('-C --pem-prefix [path prefix of pem file]', 'SSL (C)ert prefix, {key: @-key.pem, cert: @-cert.pem} for https server')
  .option('-P --listen-path [filepath]', 'unix-domain-socket/windows-named-pipe path')
  .option('-s --raw-scgi [port:host]', 'SCGI listening address', 1531)
  .option('-r --raw-http [port:host]', 'raw HTTP listening address', '1530')
  .option('-c, --client_config [file]', 'client control configuration file path')
  .option('-k, --keep_alive_interval [seconds]', 'keep_alive_interval', parseInt)
  .option('-a, --auth_checker_path [file(js function or json static config)]', 'authentication func or config')
  .parse(process.argv)
;

global.args = program;
global.startCfg = {
  client_config : program.client_config,
  auth_checker_path : program.auth_checker_path,
  keep_alive_interval : program.keep_alive_interval || 280,
  db : {
    name : program.db_name,
    domain : program.db_domain,
    unique : program.db_unique_name,
    inst : program.db_instance,
    role : program.db_role,
    cfg_id : program.db_cfg_id
  }
};

(function initConfig(cfg){
  console.log(cfg);
  if (cfg.client_config) {
    client_cfgs = require(cfg.client_config);
    global.gConfig = client_cfgs;
    if (client_cfgs.client_config) {
      client_cfgs = client_cfgs.client_config;
    }
  } else {
    client_cfgs = {
      demo : {
        min_concurrency : 3,
        max_concurrency : 3,
        passwd : 'demo'
      }
    };
  }
  global.client_cfgs = client_cfgs;
  global.keepAliveInterval = cfg.keep_alive_interval;

  var authModule, authChecker;
  if (cfg.auth_checker_path) {
    switch (cfg.auth_checker_path[0]) {
      case '/' :
        authModule = require(cfg.auth_checker_path);
      case '.':
        authModule = require(cfg.auth_checker_path);
      default:
        authModule = require(require('path').join('./', cfg.auth_checker_path));
    }
    if (authModule && typeof authModule === 'function') {
      global.authChecker = authModule.check(cfg);
    } else {
      // use static configuration json file for checker rule
      global.authChecker = require('./check_by_config.js')(authModule);
    }
  } else {
    // checker that allow intranet ip, forbid internet ip,  it's for default
    global.authChecker = require('./check_intra_inter.js')(cfg);
  }

})(startCfg);

require('./handshake.js');
