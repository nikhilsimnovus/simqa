#!/bin/bash
# Copyright (C) 2021-2024 Simnovus
# Luna configurator wrapper version 2024-09-24

set -e

# Default params
# Override them in enb configuration file, rf_driver/config_script_param section
OUT_FREQ="28000080000"
SDR_NUM="0"
UDC_TYPE="B2"
UDC_DEV="/dev/ttyUSB0"

PARAMS="$1"
SDR_DEV="$2"
IN_FREQ="$3"

MODE="master"

IFS=';' read -ra LIST <<< "$PARAMS"
for l in "${LIST[@]}"; do

    for p in $l ; do
        eval "$p"
    done

    if [ "$SDR_DEV" = "/dev/sdr${SDR_NUM}" ] ; then
        case "$UDC_TYPE" in
        A2)
            remainder=$(( ($OUT_FREQ - $IN_FREQ) % 1000000 ))
	    if [ $remainder = 0 ] ; then
              LO_FREQ=$(( ($OUT_FREQ - $IN_FREQ) / 1000000 ))
              echo "Configure UDC A2 device $UDC_DEV connected to $SDR_DEV @ ${OUT_FREQ}Hz (LO=${LO_FREQ}MHz)"
              $(dirname $0)/luna-cfg $UDC_DEV $LO_FREQ
	    else
	      echo "Invalid LO Frequency"
	      exit 1
	    fi
            ;;
        B2)
            remainder=$(( ($OUT_FREQ - $IN_FREQ) % 1000000000 ))
            if [ $remainder = 0 ] ; then
              stty -F $UDC_DEV 230400 -brkint -icrnl -imaxbel -opost -isig -icanon -echo -echoe
              LO_FREQ=$(( ($OUT_FREQ - $IN_FREQ) / 1000000000 ))
              echo "Configure UDC B2 device $UDC_DEV connected to $SDR_DEV @ ${OUT_FREQ}Hz (LO=${LO_FREQ}GHz)"
              echo 'udc_r_help' > $UDC_DEV
              if [ "$MODE" = "master" ] ; then 
                echo "udc_w_lo_in_""$LO_FREQ" > $UDC_DEV
                MODE="slave"
              else
                echo 'udc_s_exlo_init' > $UDC_DEV
              fi
              echo 'udc_s_tx_1' > $UDC_DEV 
              echo 'udc_s_trx2_rx' > $UDC_DEV
            else
              echo "Invalid LO Frequency"
              exit 1
            fi
            ;;
        B4)
            remainder=$(( ($OUT_FREQ - $IN_FREQ) % 1000 ))
            if [ $remainder = 0 ] ; then
              stty -F $UDC_DEV 230400 -brkint -icrnl -imaxbel -opost -isig -icanon -echo -echoe raw line 0
              LO_FREQ=$(( ($OUT_FREQ - $IN_FREQ) / 1000 ))
              echo "Configure UDC B4 device $UDC_DEV connected to $SDR_DEV @ ${OUT_FREQ}Hz (LO=${LO_FREQ}KHz)"
              echo 'udc_r_help' > $UDC_DEV
              echo 'udc_w_ckg-ref-mode 3' > $UDC_DEV
              echo "udc_s_lo-k ""$LO_FREQ" > $UDC_DEV
              echo 'udc_s_tx 1' > $UDC_DEV 
              echo 'udc_s_rx 2' > $UDC_DEV
              echo 'udc_s_tx 3' > $UDC_DEV
	      echo 'udc_s_rx 4' > $UDC_DEV
            else
              echo "Invalid LO Frequency"
              exit 1
            fi
            ;;
        *)
            echo "Unknown Up/Down converter type $UDC_TYPE"
            exit 1
            ;;
        esac
    fi
done

exit 0
