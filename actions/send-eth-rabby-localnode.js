// Action: send-eth-rabby-localnode — send-eth-rabby with Ethereum pointed at a
// LAN node through Rabby's UI first. Uses the warm wallet-profile.
// Rabby's CSP has no connect-src, so (unlike Rainbow) the LAN URL works as-is.
// wallet: rabby
process.env.LOCAL_RPC = process.env.LOCAL_RPC || "http://192.168.68.54:8545";
require("./send-eth-rabby.js");
