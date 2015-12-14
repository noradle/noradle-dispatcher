#!/usr/bin/env node

var program = require('commander');
console.log(process.argv);
program
  .version('0.13.1')
  .option('-p, --listen_port [port]', 'listening port', 1522)
  .option('-c, --client_config [file]', 'client control configuration file path')
  .option('-k, --keep_alive_interval [seconds]', 'keep_alive_interval', 280)
  .option('--db_name [value]', 'db_name filter')
  .option('--db_domain [value]', 'db_domain filter')
  .option('--db_unique_name [value]', 'db_unique_name filter')
  .option('--db_instance [value]', 'db_instance filter')
  .option('--db_role [value]', 'db_role filter')
  .option('--db_cfg_id [value]', 'db_cfg_id filter')
  .parse(process.argv)
;

require('./dispatcher.js').start({
  listen_port : program.listen_port,
  client_config : program.client_config,
  keep_alive_interval : program.keep_alive_interval,
  db : {
    name : program.db_name,
    domain : program.db_domain,
    unique : program.db_unique_name,
    inst : parseInt(program.db_instance),
    role : program.db_role,
    cfg_id : program.db_cfg_id
  }
});