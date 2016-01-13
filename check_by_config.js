/**
 * Created by cuccpkfs on 16-1-13.
 */

'use strict';

module.exports = function(cfg){
  console.log('auth check by %s', __filename);
  return function check_by_config(authAttr){
    // check according to config rules
    return false;
  }
}
