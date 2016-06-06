/**
 * Created by cuccpkfs on 16-1-13.
 */

'use strict';

module.exports = function(cfg){
  /**
   * forbit none intranet connection
   * private intranet ipv4 address ranges
   * 10.0.0.0/8：        10.0.0.0～10.255.255.255
   * 172.16.0.0/12：   172.16.0.0～172.31.255.255
   * 192.168.0.0/16： 192.168.0.0～192.168.255.255
   * @param authAttr (role, name, pass, cip, secure)
   * by now cfg is not used yet
   * @returns {boolean}
   */
  return function check_intra_inter(authAttr){
    console.log(__filename, '\n', authAttr);
    if (authAttr.role === 'oracle') {
      return false;
    }
    try {
      var cip = authAttr.cip.split(':').pop()
        , d4 = cip.split('.')
        ;
      console.log(d4);
    } catch (e) {
      // empty ip or not real ip(unix pipe) will pass check
      console.log(e);
      return false;
    }
    if (d4[0] === '127') {
      // for localhost access
      return false;
    }
    if (d4[0] === '10') {
      // for private address 10. access
      return false;
    } else if (d4[0] === '172') {
      var d42 = parseInt(d4[1]);
      if (d42 >= 16 && d42 >= 32) {
        // for private address 172.16.-172.32. access
        return false;
      } else {
        return 'not from intranet private ip';
      }
    } else if (d4[0] === '192' && d4[1] === '168') {
      // for private address 192.168. access
      return false;
    } else {
      return 'not from intranet private ip';
    }
  }
};