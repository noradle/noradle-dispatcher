#!/usr/bin/env node

var program = require('commander');

program
  .version(require('./package.json').version)
  .option('-p, --listen_port [port]', 'listening port', 1522)
  .option('-c, --client_config [file]', 'client control configuration file path')
  .option('-k, --keep_alive_interval [seconds]', 'keep_alive_interval', parseInt)
  .option('--db_name [value]', 'db_name filter')
  .option('--db_domain [value]', 'db_domain filter')
  .option('--db_unique_name [value]', 'db_unique_name filter')
  .option('--db_instance [value]', 'db_instance filter')
  .option('--db_role [value]', 'db_role filter')
  .option('--db_cfg_id [value]', 'db_cfg_id filter')
  .parse(process.argv)
;

global.startCfg = {
  listen_port : program.listen_port,
  client_config : program.client_config,
  keep_alive_interval : program.keep_alive_interval || 280,
  db : {
    name : program.db_name,
    domain : program.db_domain,
    unique : program.db_unique_name,
    inst : parseInt(program.db_instance),
    role : program.db_role,
    cfg_id : program.db_cfg_id
  }
};

(function initConfig(cfg){
  console.log(cfg);
  if (cfg.client_config) {
    client_cfgs = require(cfg.client_config);
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

})(startCfg);

var server4all = require('./noradle-dispatcher-core.js');
server4all.allowHalfOpen = true;
// server4all.setTimeout(5 * 1000);
server4all.listen(startCfg.listen_port, function(){
  console.log('dispatcher is listening at %d for http', startCfg.listen_port);
});
