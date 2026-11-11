Uses [Albion Online Data Project(AODP) client](https://github.com/ao-data/albiondata-client.git)
 and npcap for the live market data, instead of sending to the community server it redirects it to my own private express server where im the only who has that scanned data. It gets processed and displayed in the browser. Thats bout it


 redirect AODP data:
 & "C:\Program Files\Albion Data Client\albiondata-client.exe" -i "http://127.0.0.1:3000,http+pow://pow.east.albion-online-data.com"
