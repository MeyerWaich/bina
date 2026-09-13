#!/usr/bin/with-contenv bashio
export ANTHROPIC_API_KEY="$(bashio::config 'anthropic_api_key')"
export BINA_MODEL="$(bashio::config 'model')"
export HA_URL="http://supervisor/core"
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export BINA_PORT=8787
export BINA_HOUSE=/data/house.json
export BINA_DATA=/data
if [ ! -f /data/house.json ]; then
  node -e '
    const o=JSON.parse(require("fs").readFileSync("/data/options.json","utf8"));
    const h={name:o.house_name,timezone:o.timezone,residents:[{id:"owner",name:o.owner_name,role:"owner",language:o.language,brief:true}],protected:o.protected_entities||[],quiet_hours:{start:"23:00",end:"07:00"},preferences:[],memory:[]};
    require("fs").writeFileSync("/data/house.json",JSON.stringify(h,null,2));'
fi
bashio::log.info "Starting Bina for $(bashio::config 'house_name')"
cd /opt/bina/server && exec node server.js
