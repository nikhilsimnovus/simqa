#!/bin/bash
# Copyright (C) 2023-2025 Simnovus
# UDC automatic configuration version 2025-09-19

set -e

trap "UDC configuration terminated with SIGINT ; exit" SIGINT
trap "UDC configuration terminated with SIGQUIT; exit" SIGQUIT
trap "UDC configuration terminated with SIGTERM; exit" SIGTERM


# Move to script dir
cd $(dirname $(readlink -f $0))

# ---------------------------------
# Variables used inside this script
# ---------------------------------
verbose="1"
read_timeout="2"

read_fw_ver="0.0"
udc_A_fw_upgrade="false"
FR2_RFs=""
FR2_BWs=""
LO=""
FW_Check=""

UDC_current_lo="na"
UDC_current_clock="na"
UDC_current_port1="na"
UDC_current_port2="na"
UDC_current_port3="na"
UDC_current_port4="na"

configured_clock_sourceB4="na"
effective_clock_sourceB4="none"
calibrate="false"
calibration_done="false"
eprom_done="false"
delivery="false"

UDC_config_port1="na"
UDC_config_port2="na"
UDC_config_port3="na"
UDC_config_port4="na"
TRX_4_CH=("na" "na" "na" "na")

XMM="2"



selected_udc_type=9999
TXports="default"
RXports="default"
ClockInfo="default"
scan_all_ports="false"   # true=scan all port and detects all devices, false= detects just devices listed in args

PrefStart=2130000000     # Prefered freq to start the optimization Hz. Valid for all types except B239
PrefStart_B39=3300000000 # Prefered freq to start the optimization Hz. Valid for all types except B239

delta=500000         # Hz delta aroud forbidden freq 


computed_BW=0 # computed Bandwidth based on the Input params of the script(RF min and RF max)
computed_half_bw=0 
computed_cf=0 # computed Central Freq based on the Input params of the script(RF min and RF max)

return_LO=0                # LO with which the UDC is configured
return_TX_POWER_OFFSET=0   # gain dB applied by the UDC. It counts for tuningt the SIB1 signal level
return_TX_GAIN_MARGIN=0    # Error margin id dB to be applied for starting with the correct tx gain
return_IF=()               # IF frequency to be used to configure each RF port
return_TX_POWER_MAX=()     # Max power in dB that can be sent to the RF port
return_TXG=()              # TO BE REMOVED
trx_sdr_dir="/root/trx_sdr" # directory of trx sdr

A_serial="ACM"
B_serial="USB"
serial_types=("ACM" "USB")
found_counter=(0 0 0 0 0 0)

rows=({0..10}) 
cols=({0..5})  
declare -A FOUND_DEVS
declare -A MATCH_DEVS
declare -A CFG_ARGS
for i in ${rows[@]};
do
    for j in ${cols[@]};
    do
        FOUND_DEVS[$i,$j]="0" # each row is corresponds to a udc device, # each col corresponds to a udc type (0)B228 (1)B239 (2)A228 (3)A239 (4)B428
        MATCH_DEVS[$i,$j]="0" # each row is corresponds to a udc device, # each col corresponds to a udc type (0)B228 (1)B239 (2)A228 (3)A239 (4)B428
        CFG_ARGS[$i,$j]="0"   # each row is corresponds to a udc device, # col0=Port,col1=clock,col2=txport,col3=rxport 

    done
done

declare -a matches
for j in ${cols[@]};
do
        matches[$j]="0"
done

declare -a udc_status_lines

declare -A datasheets
# column 0 = min rf, column 1 = max rf, column 2 = max BW, column 3 = min LO, column 4 = max LO
# row 0 = B228, row 1 = B239, row 2 = A228, row 3 = A239, row 4 = B428
datasheets[0,0]=24000000000 #B228 min rf 24  GHz
datasheets[0,1]=30000000000 #B228 max rf 30  GHz 
datasheets[0,2]=1000000000  #B228 BW     1   GHz
datasheets[0,3]=19000000000 #B228 min LO 19  GHz
datasheets[0,4]=27000000000 #B228 max LO 27  GHz
datasheets[0,5]=2100000000  #B228 min IF 2.1 GHz
datasheets[0,6]=5600000000  #B228 max IF 5.6 GHz
datasheets[0,7]=25          #B228 dB Up conversion PA amplification
datasheets[0,8]=-31         #B228 max applicable TXpower to IF UDC port
datasheets[0,9]=6           #B228 maximum dB error tolerance worst case sat (+3dB err sdr +3dB err udc)

datasheets[1,0]=37000000000 #B239 min rf 37  GHz
datasheets[1,1]=40000000000 #B239 max rf 40  GHz
datasheets[1,2]=1000000000  #B239 BW     1   GHz
datasheets[1,3]=32000000000 #B239 min LO 32  GHz
datasheets[1,4]=36000000000 #B239 max LO 36  GHz
datasheets[1,5]=3300000000  #B239 min IF 3.3 GHz
datasheets[1,6]=6700000000  #B239 max IF 6.7 GHz
datasheets[1,7]=25          #B239 dB Up conversion PA amplification
datasheets[1,8]=-31         #B239 max applicable TXpower to IF UDC port
datasheets[1,9]=6           #B239 maximum dB error tolerance worst case sat (+3dB err sdr +3dB err udc)

datasheets[2,0]=20000000000 #A228 min rf 20  GHz
datasheets[2,1]=30000000000 #A228 max rf 30  GHz
datasheets[2,2]=1000000000  #A228 BW     1   GHz
datasheets[2,3]=16000000000 #A228 min LO 16  GHz # in the old firmware version it was 22-24. Applied in setupcheck
datasheets[2,4]=28000000000 #A228 max LO 28  GHz
datasheets[2,5]=2000000000  #A228 min IF  2  GHz
datasheets[2,6]=6000000000  #A228 max IF  6  GHz
datasheets[2,7]=18          #A228 dB Up conversion PA amplification
datasheets[2,8]=-30         #A228 dBm max applicable TXpower to IF UDC port
datasheets[2,9]=6           #A228 maximum dB error tolerance worst case sat (+3dB err sdr +3dB err udc)

datasheets[3,0]=30000000000 #A239 min rf 30  GHz
datasheets[3,1]=48000000000 #A239 max rf 48  GHz
datasheets[3,2]=1000000000  #A239 BW     1   GHz
datasheets[3,3]=28000000000 #A239 min LO 28  GHz
datasheets[3,4]=42000000000 #A239 max LO 42  GHz
datasheets[3,5]=2000000000  #A239 min IF  2  GHz
datasheets[3,6]=6000000000  #A239 max IF  6  GHz
datasheets[3,7]=20          #A239 dB Up conversion PA amplification
datasheets[3,8]=-25         #A239 dBm max applicable TXpower to IF UDC port
datasheets[3,9]=6           #A239 maximum dB error tolerance worst case sat (+3dB err sdr +3dB err udc)

datasheets[4,0]=24000000000 #B428 min rf 24  GHz
datasheets[4,1]=30000000000 #B428 max rf 30  GHz
datasheets[4,2]=1000000000  #B428 BW     1   GHz
datasheets[4,3]=19000000000 #B428 min LO 19  GHz
datasheets[4,4]=27000000000 #B428 max LO 27  GHz
datasheets[4,5]=2100000000  #B428 min IF 2.1 GHz
datasheets[4,6]=5600000000  #B428 max IF 5.6 GHz
datasheets[4,7]=24          #B428 dB max Up conversion PA amplification according to manifacturer
datasheets[4,8]=-31         #B428 dBm max applicable TXpower to IF UDC to avoid saturation
datasheets[4,9]=6           #B428 maximum dB error tolerance worst case sat (+3dB err sdr +3dB err udc)

datasheets[5,0]=37000000000 #B439 min rf 37  GHz
datasheets[5,1]=50000000000 #B439 max rf 50  GHz
datasheets[5,2]=1000000000  #B439 BW     1   GHz
datasheets[5,3]=32000000000 #B439 min LO 32  GHz
datasheets[5,4]=48000000000 #B439 max LO 48  GHz
datasheets[5,5]=2000000000  #B439 min IF 2 GHz
datasheets[5,6]=5000000000  #B439 max IF 5 GHz
datasheets[5,7]=35          #B439 max Up conversion PA amplification according to manifacturer
datasheets[5,8]=-44         #B439 dBm max applicable TXpower to IF UDC port to avoid saturation
datasheets[5,9]=6           #B428 maximum dB error tolerance worst case sat (+3dB err sdr +3dB err udc)

usage1()
{
    local func="$1"
    $func "usage:"
    $func "    ./udc-auto-cfg.sh <args> -p <freq Hz> <bandwidth Hz> <min freq> <max freq> options"    
    $func ""
    $func "examples:"
    $func "    ./udc-auto-cfg.sh  \"devUDCx;clock=internal;tx=1,3;rx=2,4\" -p \"Cell Central Freq\" \"Cell BW\" \"Cell Min Freq\" \"Cell Max Freq\" options"
    $func "    ./udc-auto-cfg.sh  \"/dev/ttyUSB0\" -p \"25050000000\" \"100000000\" \"25000000000\" \"25100000000\" --lo 22000000000 -v"
    $func "    ./udc-auto-cfg.sh  \"/dev/ttyUSB0\" -p \"25050000000\" \"100000000\" \"25000000000\" \"25100000000\" "
    $func ""
    $func "options:"
    $func "    <args> clock=internal,external,gps for (UDC B4)"
    $func "    <args> clock=internal,external for (UDC B2)"
    $func "    <args> tx=1,2,3,4 (UDC B4 and UDC B2)"
    $func "    <args> rx=1,2,3,4 (UDC B4 and UDC B2)"
    $func "    -h|--help: show this menu"
    $func "    -p: <freq Hz> <bandwidth Hz> per rf port parameters"
    $func "    -l|--lo: <lo_frequency Hz> impose specific lo frequency, zero or empty for auto config"
    $func "    -q: quiet mode"
    $func "    -v: verbose mode (debug)"
    $func "    -f: <string> .Pass as string argument the firmware version to check"
    $func "    -d|--del: use delivery option"
    $func "    -c|--cal: Calibrate UDCB4"
    $func "    -t <timeout>: tty read timeout in secondes (default = 2s)"
}

usage()
{
    usage1 Error
    if [ "$1" = "" ] ; then
        Error "error: missing parameters for configuration script"
    else
        Error "$1"
    fi
    exit 1
}

function Log
{
    if [[ "$verbose" -ge 1 ]] ; then
        echo -e "$@"
    fi
}

function Debug
{
    if [[ "$verbose" -ge 2 ]] ; then
        echo -e "$@"
    fi
}

function Error
{
    echo -e "$@" >&2
}

# ---------------------------------
# Parse command line
# ---------------------------------
while [ "$1" != "" ] ; do
    case $1 in
    -H|--help)
        usage
        ;;

    -h|--help)
        verbose="1"
        usage1 Log
        exit 0
        ;;
    --)
        Error "no parm"
        ;;

    -q)
        verbose="0"
        ;;
    -v)
        verbose="2"
        ;;
    -t)
        read_timeout="$2"
        shift
        ;;
    -l|--lo)
        LO="$2"
        shift
        ;;
    -f|--fw)
        FW_Check="$2"
        shift
        ;;
    -d|--del)
        delivery="true"
        ;;
    -c|--cal)
        calibrate="true"
        ;;
    -p)
        FR2_RFs+="$2"
        FR2_RFs+=";"
        shift
        FR2_BWs+="$2"
        FR2_BWs+=";"
        shift
        ;;

    *)
        if [ "$ARGS" = "" ] ; then
            ARGS="$1"
        elif [ "$MIN_FREQ" = "" ] ; then
            MIN_FREQ="$1"
        elif [ "$MAX_FREQ" = "" ] ; then
            MAX_FREQ="$1"
        else
            usage "bad argument $1"
        fi
        ;;
    esac

    shift
done




# Not enough arguments
if [ "$LO" = "" ] ; then
   #usage
   LO=0 # fallback in the case LO not specified auto cfg
fi

if [[ "$delivery" == "false" ]] ; then 
source udc-freq.sh 
fi

# ---------------------------------
# Functions
# ---------------------------------

sendToExit(){
    cause=$1
    Error "error: $cause"
    exec 3<&-
    exit 1
}

add_device_found(){
    local id=$1
    local type=$2

    FOUND_DEVS[${found_counter[$type]},$type]="$id"
    found_counter[$type]=$((found_counter[$type]+1))

}

readInstruction()
{
    local instruction=$1
    local port_type=$2
    local __cmdresult=$3
    local cmdok="false"
    is_B2="false"
    is_B4="false"
    pass_line="false"
    pass_line2="false"
    local is_command="false"
    local timeout="$read_timeout"

    while IFS=$"\n" [ true ] ; do
        read -u 3 -t $timeout -r line || true
        if [ "$line" = "" ] ; then break; fi
        timeout="0.3" #increased from 0.1 to 0.3 because XMM is slower to return and this command was splitted in several lines

        Debug "read from $port_type: $line"

        # ----- ALL COMMANDS OF UDC A2 -----
        # for each known command process the output
        if [[ "$port_type" == *"$A_serial"* ]] ; then 
            if [[ "$instruction" == "V" ]] ; then 
                if [[ "$line" == *"Micro"* ]] ; then
                    read_fw_ver=${line#"G5TS_Micro V"}
                    if awk -v num1="$read_fw_ver" -v num2="2.34" 'BEGIN{exit !(num1 < num2)}'; then
                        udc_A_fw_upgrade="true"
                        Debug "UDC $port_type firmware not up to date, consider to upgrade it"
                    fi
                    cmdok="true"
                    break
                fi
            elif [[ "$instruction" == "VS" ]] ; then
                if [[ "$line" == *"Td39"* ]] ; then
                    add_device_found $port_type "3" #3=A239
                    cmdok="true"
                    break
                elif [[ "$line" == *"Td28"* ]] ; then
                    add_device_found $port_type "2" #2=A228
                    cmdok="true"
                    break
                fi
            elif [[ "$instruction" == "XMM $XMM" ]] ; then 
                if [[  "$line" == *"XMM $XMM"* ]] ; then
                    is_command="true"
                fi
                if [[  "$line" == *"OK"* ]] && [[  "$is_command" == "true" ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == "XFF" ]] ; then              
                if [[  "$line" == *"XFF"* ]] ; then
                    is_command="true"
                fi
                if [[ "$line" == *"[$LO_div4MHz]"* ]] && [[  "$is_command" == "true" ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == "U0" ]] ; then 
                if [[  "$line" == *"U0"* ]] ; then
                    is_command="true"
                fi
                if [[ "$line" == *"F[$(($LO_div4MHz))]M[$XMM]"* ]] && [[  "$is_command" == "true" ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            else
               Error "unrecognized instruction $instruction for udc"
            fi
        fi

        # ----- ALL COMMANDS OF UDCs TYPE B ----- 
        if [[ "$port_type" == *"$B_serial"* ]] ; then
            if [[ "$instruction" == "udc_r_ver" ]] ; then 
                # process udc_r_ver
                if [[  "$line" == *"FW_VER"* ]] ; then
                    read_fw_ver=${line#"FW_VER:"}
                    continue
                elif [[  "$line" == *"UDC_2CH"* ]] ; then 
                    is_B2="true"
                    #pass_line2="true"
                    continue
                elif [[ "$line" == *"UDCB4 firmware"* ]]; then 
                    # case of UDCB428 for customers
                    is_B4="true"
                    read_fw_ver=${line#"UDCB4 firmware version:"}
                    read_fw_ver=$(echo ${read_fw_ver//[[:blank:]]/})
                    cmdok="true"
                    break
                elif [[ "$line" == *"UDCB4 37-48 firmware version"* ]] ; then 
                    # UDC4 firmware for B43748 clients version
                    is_B4="true"
		    read_fw_ver=${line#"UDCB4 37-48 firmware version:"}
                    read_fw_ver=$(echo ${read_fw_ver//[[:blank:]]/})
                    cmdok="true"
                    break
                elif [[  "$line" == *"28g"* ]] && [[  "$is_B2" == "true" ]] ; then 
                    add_device_found $port_type "0" #0=B228
                    cmdok="true"
                    break
                elif [[  "$line" == *"39g"* ]] && [[  "$is_B2" == "true" ]]; then 
                    add_device_found $port_type "1" #1=B239
                    cmdok="true"
                    break
                fi
            ####################################
            # ----- ALL COMMANDS OF UDC B2 -----
            ####################################
            elif [[ "$instruction" == *"udc_s_tx_"* ]] ; then 
                if [[  "$line" == *"udc_s_tx_"* ]] ; then
                    is_command="true"
                fi
                if [[  "$line" == *"ok"* ]] && [[  "$is_command" == "true" ]] ; then
                    cmdok="true"
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_s_trx"* ]] ; then 
                if [[  "$line" == *"udc_s_trx"* ]] ; then
                    is_command="true"
                fi
                if [[  "$line" == *"ok"* ]] && [[  "$is_command" == "true" ]] ; then
                    cmdok="true"
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_w_lo_in_"* ]] ; then 
                if [[  "$line" == *"udc_w_lo_in_"* ]] ; then
                    is_command="true"
                fi
                if [[  "$line" == *"ok"* ]] && [[  "$is_command" == "true" ]] ; then
                    cmdok="true"
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_s_exlo_init"* ]] ; then 
                if [[  "$line" == *"udc_s_exlo_init"* ]] ; then
                    is_command="true"
                fi
                if [[  "$line" == *"ok"* ]] && [[  "$is_command" == "true" ]] ; then
                    cmdok="true"
                else
                    continue
                fi
            ####################################
            # ----- ALL COMMANDS OF UDC B4 -----
            ####################################
            elif [[ "$instruction" == *"udc_r_band"* ]] ; then 
                if [[  "$line" == *"24-30"* ]] ; then
                    add_device_found $port_type "4" #4=B428
                    cmdok="true"
                    break
                elif [[  "$line" == *"37-48"* ]] ; then
                    add_device_found $port_type "5" #5=B439
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_s_lo"* ]] ; then 
                if [[  "$line" == *"OK"* ]] || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_w_ckg-ref-mode"* ]] ; then 
                if [[  "$line" == *"OK"* ]] || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_s_tx"* ]] ; then 
                if [[  "$line" == *"OK"* ]]  || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_s_rx"* ]] ; then 
                if [[  "$line" == *"OK"* ]]  || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_s_ch"* ]] ; then 
                if [[  "$line" == *"OK"* ]]  || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            elif [[ "$instruction" == *"udc_r_status"* ]] ; then 
                if [[  "$line" == *"OK"* ]] || [[  "$line" == *"ok"* ]]; then
                    cmdok="true"
                    break
                elif [[  "$line" == *"Configured clock source"* ]] ; then
                    configured_clock_sourceB4=${line#*:}
                    configured_clock_sourceB4=$(echo ${configured_clock_sourceB4//[[:blank:]]/})
                    udc_status_lines+=("$line")
                    continue
                elif [[  "$line" == *"Effective clock source"* ]] ; then
                    effective_clock_sourceB4=${line#*:}
                    effective_clock_sourceB4=$(echo ${effective_clock_sourceB4//[[:blank:]]/})
                    udc_status_lines+=("$line")
                    continue
                else 
                    udc_status_lines+=("$line")
                    continue
                fi
            elif [[ "$instruction" == *"udc_w_ckg-calib"* ]] ; then 
                timeout="30"
                if [[  "$line" == *"OK"* ]]  || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    continue
                elif [[  "$line" == *"System calibration done"* ]]  ; then
                    calibration_done="true"
                    break
                elif [[  "$line" == *"too many times fail"* ]] ; then
                    calibration_done="false"
                    break
                else 
                    continue
                fi
            elif [[ "$instruction" == *"udc_s_save-all"* ]] ; then 
                timeout="15"
                if [[  "$line" == *"OK"* ]]  || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    break
                elif [[  "$line" == *"Save EEPROM done"* ]]  ; then
                    eprom_done="true"
                    continue
                else 
                    continue
                fi
	    elif [[ "$instruction" == *"udc_w_amp-monitor"* ]] ; then
                if [[  "$line" == *"OK"* ]]  || [[  "$line" == *"ok"* ]] ; then
                    cmdok="true"
                    break
                else
                    continue
                fi
            else
               Error "unrecognized instruction $instruction for udc" 
            fi
        fi

    done
    IFS=$' '
    eval $__cmdresult="'$cmdok'"
}

sendInstruction()
{
    local instruction=$1
    local param=$2
    local port=$3

    cmdresult="false" # variable that will contain the returned value of command OK or NOK
    for iteration in {1..10} 
    do # need multiple iterations in case the command is not taken

        # Close/Open device
        exec 3<&-
        exec 3<$port
        echo "\n" >3 
        while [ true ] ; do
           read -u 3 -t 0.1 -r line || true
           if [ "$line" = "" ] ; then break; fi
        done
        

        # Send
        echo -e "$instruction$param" > $port

        # Read
        readInstruction "$instruction" "$port" "cmdresult"

        # Close
        exec 3<&-

        if [ $iteration -eq 10 ] && [ "$cmdresult" == "false" ]; then
            Error "fail: cannot use instruction $instruction on UDC $port"
            sendToExit "cannot use instruction on udc, reboot your UDC"
        elif [ $iteration -gt 1 ] && [ $iteration -lt 10 ] && [ "$cmdresult" == "false" ]; then 
            Debug "fail: try #$iteration. cannot use instruction $instruction on UDC $port"   
        elif [ "$cmdresult" == "true" ]; then
            #Debug "--> command $instruction completed OK."
            break 
        else
            continue
        fi
    done
}

AutoDetectUdcType(){

    local port="$1"

    if [[ "$port" == *"$A_serial"* ]]; then
        #sendInstruction "VS" "\n\r" $port
        stty -F $port 230400 -brkint -icrnl -imaxbel -opost -isig -icanon -echo -echoe #original line
        sendInstruction "VS" "\r\n" $port
        sendInstruction "V" "\r\n" $port
    elif [[ "$port" == *"$B_serial"* ]]; then
        stty -F $port 230400 min 1 -opost -isig -icanon iexten -echo -echoe -brkint -icrnl -imaxbel 
        sendInstruction "udc_r_ver" "" $port
        if [[ "$is_B4" == "true" ]]; then
            sendInstruction "udc_r_band" "" $port
        fi
    else
        Error "unrecognized serial port type $d"
        sendToExit "unrecognized serial"
    fi
}

AutoDetectDevice(){
for r in ${rows[@]} ;
do

    if [[ "${CFG_ARGS[$r,0]}" == "0" ]]; then
        break;
    fi
    
    for serial in ${serial_types[@]}
    do
        # if serial corresponds to one of the arguments then do the operation
        # it will launch the Auto detection only for the mentioned devices. 
        if [[ "$scan_all_ports" == "false" ]] ; then
            if [[ "${CFG_ARGS[$r,0]}" != *"$serial"* ]]; then
                continue;
            fi
        fi
        dev_is_enumerated="false"
        dev_is_mounted_ok="false"
        IFS=$'\n'

        if ! dev_prop=$(ls -la1 /dev/tty$serial* 2>/dev/null) > /dev/null 2>&1; then
            echo "command failed: ls -la1 /dev/tty$serial* "
        fi
        #dev_prop=$(ls -la1 /dev/tty$serial* 2>/dev/null)

        if [ ${#dev_prop[@]} -ne 0 ]; then
            for line_ in ${dev_prop[@]}
            do
                readarray -d ' ' -t arr <<< "$line_"

                if [[ "${arr[0]:0:1}" == "c" ]] ; then
                    devfullpath=${arr[-1]}
                    devname=${devfullpath#*/dev/}
                    devname=${devname//$'\n'/} # Remove all newlines.

                    if [[ "${CFG_ARGS[$r,0]}" == *"$devname"* ]] ; then
                        dev_is_enumerated="true"
                        if [[ "$devname" == *"USB"* ]] ; then
                            msgoutput=$(ls -l /dev/serial/by-id/) # command to check all devices connected 
                            for outputline in $msgoutput
                            do
                                if [[ "$outputline" == *"$devname"* ]] ; then
                                    if [[ "$outputline" == *"FTDI_FT232R_USB_UART"* ]] ; then
                                        #UDC B type
                                        dev_is_mounted_ok="true"
                                        continue;
                                    elif [[ "$outputline" == *"STMicroelectronics_STM32_Virtual"* ]] ; then
                                        #UDC A type
                                        dev_is_mounted_ok="true"
                                        continue;
                                    else
                                        dev_is_mounted_ok="false"
                                        Error "device ${arr[-1]} not recognized as UDC"
                                        sendToExit "cannot use ${arr[-1]}"
                                    fi
                                else
                                    continue;
                                fi
                            done

                            if [[ "$dev_is_mounted_ok" == "true" ]] ; then
                                Debug "device is properly mounted: ${arr[0]} ${arr[-1]}"
                                AutoDetectUdcType ${arr[-1]}
                                break;
                            fi
                        else
                            # UDC A family. Any known way to discriminate against other ACM devices plugged in the machine
                            # For the UDC A didn't yet find a way to discriminate it
                            Debug "device name $devname belongs to UDC A class"
                            AutoDetectUdcType ${arr[-1]}
                            break;
                        fi
                    else
                        continue;
                    fi        
                else
                    echo "${arr[0]:0:1} "
                    Error "not accessible serial port for device ${arr[0]} ${arr[-1]}"
                    sendToExit "not accessible serial port for device"
                fi
            done
            if [ "$dev_is_enumerated" == "false" ] ; then
                Error "device ${CFG_ARGS[$r,0]} is not properly enumerated" 
                sendToExit "cannot find requested device ${CFG_ARGS[$r,0]}"
            fi
        fi

    done
done
}

CheckArg(){
    local arg=$1
    for i in ${rows[@]} ;
    do
     for j in ${cols[@]} ;
        do
            if [[  "$arg" == "${FOUND_DEVS[$i,$j]}" ]] ; then
                MATCH_DEVS[$i,$j]="$arg"
                #Debug "recognised DEV ARG $arg with detected device ${FOUND_DEVS[$i,$j]}"
            fi
        done
    done
}


SetupCheck(){
    # count number of UDC and display match
    for j in ${cols[@]} ;
    do
        for i in ${rows[@]} ;
        do
            if [[  "0" != "${MATCH_DEVS[$i,$j]}" ]] ; then
                if [[  "0" == "${matches[$j]}" ]] ; then
                    matches[$j]="${MATCH_DEVS[$i,$j]}"
                else
                    matches[$j]="${matches[$j]};${MATCH_DEVS[$i,$j]}"
                fi
            fi
        done

        #print the matches
        if [ $j -eq 0 ] ; then
            Log "recognised B228 list: ${matches[$j]}"
        elif [ $j -eq 1 ] ; then
            Log "recognised B239 list: ${matches[$j]}"
        elif [ $j -eq 2 ] ; then
            Log "recognised A228 list: ${matches[$j]}"
        elif [ $j -eq 3 ] ; then
            Log "recognised A239 list: ${matches[$j]}"
        elif [ $j -eq 4 ] ; then 
            Log "recognised B4 24-30 list: ${matches[$j]}"
        elif [ $j -eq 5 ] ; then 
            Log "recognised B4 37-48 list: ${matches[$j]}"
        else
            Error "cannot match ${matches[$j]} to any known UDC type"
            sendToExit "cannot match UDC"
        fi  
    done

    for j in ${cols[@]} ;
    do
        local count=0
        for i in ${rows[@]} ;
        do
            if [[  "0" != "${MATCH_DEVS[$i,$j]}" ]] ; then
                count=$((count+1))
            fi
        done
        if [ $j -eq 0 ] || [ $j -eq 1 ] || [ $j -eq 2 ] || [ $j -eq 3 ] && [ $count -gt 2 ] ; then
            Error "cannot match more than 2 UDCs in a single udc port" #if B2 or A2 not possible to have more than two in a single udc port
            sendToExit "cannot match UDC on udc_port element"
        elif ([ $j -eq 0 ] || [ $j -eq 1 ] || [ $j -eq 2 ] || [ $j -eq 3 ]) && [ $count -ge 1 ] ; then
            selected_udc_type=$j
            break
        elif [ $j -eq 4 ] || [ $j -eq 5 ]  && [ $count -gt 1 ] ; then
            Error "cannot match more than 1 UDCs in a single udc port" #if B4 cannot have more than one in a single udc port
            sendToExit "cannot match UDC on udc_port element"
        elif [ $j -eq 4 ] || [ $j -eq 5 ] && [ $count -eq 1 ] ; then
            selected_udc_type=$j
            break
        fi
    done


    if [ $selected_udc_type -eq 0 ] ; then
        Debug "using UDC type B228"
        return_TX_POWER_OFFSET=${datasheets[0,7]}
	    return_TX_GAIN_MARGIN=${datasheets[0,9]}
    elif [ $selected_udc_type -eq 1 ] ; then
        Debug "using UDC type B239"
        return_TX_POWER_OFFSET=${datasheets[1,7]}
	    return_TX_GAIN_MARGIN=${datasheets[1,9]}
    elif [ $selected_udc_type -eq 2 ] ; then
        Debug "using UDC type A228"
        return_TX_POWER_OFFSET=${datasheets[2,7]}
	    return_TX_GAIN_MARGIN=${datasheets[2,9]}
        #if awk -v num1="$read_fw_ver" -v num2="2.34" 'BEGIN{exit !(num1 < num2)}'; then
        if [[  "$udc_A_fw_upgrade" == "true" ]] ; then
	        if [[  "$delivery" == "false" ]] ; then
		        Debug "UDC A228 firmware not up to date, apply config restrictions"
		        datasheets[2,3]=22000000000 #A228 min LO 22  GHz
		        datasheets[2,4]=24000000000 #A228 max LO 24  GHz
	        else
		        Error "UDC A228 firmware not up to date" 
                sendToExit "UPDATE FW"
	        fi
        fi
    elif [ $selected_udc_type -eq 3 ] ; then
        Debug "using UDC type A239"
        return_TX_POWER_OFFSET=${datasheets[3,7]}
	    return_TX_GAIN_MARGIN=${datasheets[3,9]}
        if awk -v num1="$read_fw_ver" -v num2="2.34" 'BEGIN{exit !(num1 < num2)}'; then
	       if [[  "$delivery" == "false" ]] ; then
		        Debug "UDC A239 firmware not up to date"
	       else
		        Error "UDC A239 firmware not up to date" 
                sendToExit "UPDATE FW"
	       fi
        fi
    elif [ $selected_udc_type -eq 4 ] ; then 
        Debug "using UDC type B4 24-30"
        return_TX_POWER_OFFSET=${datasheets[4,7]}
	    return_TX_GAIN_MARGIN=${datasheets[4,9]}
    elif [ $selected_udc_type -eq 5 ] ; then 
        Debug "using UDC type B4 37-48"
        return_TX_POWER_OFFSET=${datasheets[5,7]}
	    return_TX_GAIN_MARGIN=${datasheets[5,9]}
    else
        Error "undefined UDC type"
        sendToExit "error undefined UDC type"
    fi  

    # check that matched UDCs are of the same type for the UDC port
    for j in ${cols[@]} ;
    do
        for i in ${rows[@]} ;
        do
            if [[  "0" != "${MATCH_DEVS[$i,$j]}" ]] && [[  "$j" != "$selected_udc_type" ]] ; then
                Error "cannot match more than one UDC type in a single UDC port" 
                sendToExit "error in udc_port arguments"
            fi
        done
    done
}

CheckRFs(){
    for f in ${FR2_FREQS[@]}; do
        if [[ $f -lt ${datasheets[$selected_udc_type,0]} ]] ; then
            Error "FR2 frequency ($f) lower than UDC capability ${datasheets[$selected_udc_type,0]} Hz"
            sendToExit "error for RF frequency selection"
        fi
        if [[ $f -gt ${datasheets[$selected_udc_type,1]} ]] ; then
            Error "FR2 frequency ($f) higher than max UDC capability ${datasheets[$selected_udc_type,1]} Hz"
            sendToExit "error for RF frequency selection"
        fi

        if [ $LO -ne 0 ] ; then
            # if an LO is specified in the config file check if would lead to IFs out of range
            possibleIF=$(awk -v f="$f" -v LO="$LO" 'BEGIN {print f - LO}')
            if [[ $possibleIF -lt ${datasheets[$selected_udc_type,5]} ]] ; then
                Error "FR2 frequency ($f)Hz - LO freq ($LO)Hz will result in IF ($possibleIF)Hz, lower than admitted UDC range ${datasheets[$selected_udc_type,5]} Hz"
                sendToExit "error for RF/LO frequency selection"
            fi
            if [[ $possibleIF -gt ${datasheets[$selected_udc_type,6]} ]] ; then
                Error "FR2 frequency ($f)Hz - LO freq ($LO)Hz will result in IF ($possibleIF)Hz, higher than admitted UDC range ${datasheets[$selected_udc_type,6]} Hz"
                sendToExit "error for RF/LO frequency selection"
            fi
        fi

    done
}

SetClock(){
count_master=0
count_slave=0

Debug "set clock:"

for r in ${rows[@]} ;
do
    if [[  "0" == "${MATCH_DEVS[$r,$selected_udc_type]}" ]] ; then
        break
    else
        if [[  "${MATCH_DEVS[$r,$selected_udc_type]}" == "${CFG_ARGS[$r,0]}" ]] ; then
            # check the clock type and apply it
            if [ $selected_udc_type -eq 0 ] ||  [ $selected_udc_type -eq 1 ] ; then
                case "${CFG_ARGS[$r,1]}" in
                "default" | "0")
                    case "$r" in
                        "0")
                            # first UDC in the list assume is the master one
                            CFG_ARGS[$r,1]="internal"
                            count_master=$(($count_master+1))
                            Debug "configure ${CFG_ARGS[$r,0]} with clock source internal"
                        ;;
                        "1")
                            # second UDC in the list assume is the slave one
                            CFG_ARGS[$r,1]="external"
                            count_slave=$(($count_slave+1))
                            Debug "configure ${CFG_ARGS[$r,0]} with clock source external"
                        ;;
                        *)
                            # Assume any other case to be impossible, no more than 2 UDCs in the same port
                            Error "cannot have more then two UDCs in a single udc_port"
                            sendToExit "check configuration file"
                        ;;
                    esac

                    ;;
                "internal")
                    CFG_ARGS[$r,1]="internal"
                    count_master=$(($count_master+1))
                    Debug "configure ${CFG_ARGS[$r,0]} with clock source internal"
                ;;
                "external")
                    CFG_ARGS[$r,1]="external"
                    count_slave=$(($count_slave+1))
                    Debug "configure ${CFG_ARGS[$r,0]} with clock source external"
                ;;
                *)
                    Error "unrecognized clock ${CFG_ARGS[$r,1]}"
                    sendToExit "unrecognized clock"
                    ;;
                esac

                if [ $count_master -gt 1 ] ; then
                    Error "cannot have more then one master UDC in a single udc_port"
                    sendToExit "check clock information in configuration file"
                fi
                if [ $count_slave -gt 1 ] ; then
                    Error "cannot have more then one slave UDC in a single udc_port"
                    sendToExit "check clock information in configuration file"
                fi
            elif [ $selected_udc_type -eq 4 ] || [ $selected_udc_type -eq 5 ] ; then
                local configure_b4_clock_number="3"
                local configure_b4_clock="internal"
                case "${CFG_ARGS[$r,1]}" in
                "0" | "default" | "internal")
                    configure_b4_clock_number="3"
                    configure_b4_clock="internal"
                    #Debug "configure ${CFG_ARGS[$r,0]} with clock source internal"
                    ;;
                "external")
                    configure_b4_clock_number="2"
                    configure_b4_clock="external"
                    #Debug "configure ${CFG_ARGS[$r,0]} with clock source external"
                    ;;

                "gps")
                    configure_b4_clock_number="1"
                    configure_b4_clock="gps"
                    #Debug "configure ${CFG_ARGS[$r,0]} with clock source gps"
                    ;;
                *)
                    Error "unrecognized clock ${CFG_ARGS[$r,1]}"
                    sendToExit "unrecognized clock"
                    ;;
                esac
                
                # before sending the instruction check if the actual status of UDC 

                if [[ ${UDC_current_clock^^} == *${configure_b4_clock^^}* ]]; then
                    Debug "UDC ${CFG_ARGS[$r,0]} already configured with clock source $UDC_current_clock"
                else 
                    sendInstruction "udc_w_ckg-ref-mode" " $configure_b4_clock_number" ${MATCH_DEVS[$r,$selected_udc_type]}
                    Debug "wait few second for the UDC ${CFG_ARGS[$r,0]} to get the effective input signal"
                    sleep 8 #Wait for few seconds for the UDC to get the effective clock source before verify
                fi
            elif [ $selected_udc_type -eq 2 ] || [ $selected_udc_type -eq 3 ] ; then
                # UDC A case does not support any clock configuration
                #if [ "${CFG_ARGS[$r,1]}" != "0" ] || [ "${CFG_ARGS[$r,1]}" != "default" ]; then
                    Debug "ignoring any clock configuration for UDC ${CFG_ARGS[$r,0]}"
                #fi 
            else 
                Error "unrecognized UDC type"
                sendToExit "unrecognized UDC type"
            fi
        fi
    fi
done
}

ApplyPorts(){

    Debug "apply tx rx ports:"

    local array_commands=$1
    local column=$2
    local row=$3   

    IFS=',' read -ra cmnd <<< "$array_commands"
    
    for i in "${cmnd[@]}"
    do
        if [[  "0" == "${MATCH_DEVS[$row,$column]}" ]] ; then
            break
        else
            sendInstruction "$i" "" ${MATCH_DEVS[$row,$column]}
        fi
    done
}

FillTRX4Ch() {
    local tx_string=$1
    local rx_string=$2

    IFS=',' read -ra substrings_tx <<< "$tx_string"

    for subs_tx in "${substrings_tx[@]}"; do
        case "$subs_tx" in
            "1") 
                if [[ "${TRX_4_CH[0]}" != "na" ]] ; then
                    Error "conflicting ports for channel 1"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[0]="tx"
                fi 
            ;;
            "2") 
                if [[ "${TRX_4_CH[1]}" != "na" ]] ; then
                    Error "conflicting ports for channel 2"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[1]="tx"
                fi 
            ;;
            "3") 
                if [[ "${TRX_4_CH[2]}" != "na" ]] ; then
                    Error "conflicting ports for channel 3"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[2]="tx"
                fi 
            ;;
            "4") 
                if [[ "${TRX_4_CH[3]}" != "na" ]] ; then
                    Error "conflicting ports for channel 4"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[3]="tx"
                fi 
            ;;
            "0" | "default")
                if [[ "${TRX_4_CH[0]}" != "na" ]] || [[ "${TRX_4_CH[2]}" != "na" ]]; then
                    Error "conflicting ports for default tx case 1,3"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[0]="tx"
                    TRX_4_CH[2]="tx"
                fi 
            ;;
            *)
                Error "unrecognized tx $tx_string"
                sendToExit "check configuration file in udc_port args"
            ;;
        esac
    done

    IFS=',' read -ra substrings_rx <<< "$rx_string"
    for subs_rx in "${substrings_rx[@]}"; do
        case "$subs_rx" in
            "1") 
                if [[ "${TRX_4_CH[0]}" != "na" ]] ; then
                    Error "conflicting tx and rx ports for channel 1"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[0]="rx"
                fi 
            ;;
            "2") 
                if [[ "${TRX_4_CH[1]}" != "na" ]] ; then
                    Error "conflicting tx and rx ports for channel 2"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[1]="rx"
                fi 
            ;;
            "3") 
                if [[ "${TRX_4_CH[2]}" != "na" ]] ; then
                    Error "conflicting tx and rx ports for channel 3"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[2]="rx"
                fi 
            ;;
            "4") 
                if [[ "${TRX_4_CH[3]}" != "na" ]] ; then
                    Error "conflicting tx and rx ports for channel 4"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[3]="rx"
                fi 
            ;;
            "0" | "default")
                if [[ "${TRX_4_CH[1]}" != "na" ]] || [[ "${TRX_4_CH[3]}" != "na" ]]; then
                    Error "conflicting ports for default rx case 2,4"
                    sendToExit "check configuration file in udc_port args"
                else 
                    TRX_4_CH[1]="rx"
                    TRX_4_CH[3]="rx"
                fi 
            ;;
            *)
                Error "unrecognized rx $rx_string"
                sendToExit "check configuration file in udc_port args"
            ;;
        esac
    done
}

ComposeUDCB4TRXCommand(){
    local __trxcommand=$1
    local command_string_trx_b4=""
    local trx_index=1

    for element in "${TRX_4_CH[@]}"; do
        case "$element" in
            "tx")
                command_string_trx_b4+="udc_s_tx $trx_index,"
            ;;
            "rx")
                command_string_trx_b4+="udc_s_rx $trx_index,"
            ;;
            "na")
                command_string_trx_b4+="udc_s_ch $trx_index off,"
            ;;
            *)
                Error "unrecognized tx/rx $element"
                sendToExit "check configuration file in udc_port args"
            ;;
        esac
        trx_index=$((trx_index+1))
    done

    eval $__trxcommand="'$command_string_trx_b4'"
}

SetTXRXPorts(){
    local c=999
    local command_string_tx=""
    local command_string_rx=""

    Debug "set tx rx ports:"
    
    for r in ${rows[@]} ;
    do
        command_string_tx=""
        command_string_rx=""
        if [[  "0" == "${MATCH_DEVS[$r,$selected_udc_type]}" ]] ; then
            break
        else
            if [[  "${MATCH_DEVS[$r,$selected_udc_type]}" == "${CFG_ARGS[$r,0]}" ]] ; then
                TXports="na"
                RXports="na"
                if [ $selected_udc_type -eq 0 ] ||  [ $selected_udc_type -eq 1 ] ; then
                    case ${CFG_ARGS[$r,2]} in
                    "0" | "default" | "2")
                        TXports="2"
                        command_string_tx="udc_s_tx_1"     #IF1b is tx only
                        ;;
                    "1")
                        TXports="1"
                        command_string_tx="udc_s_trx1_tx" #IF1a is tx and rx
                        ;;
                    "3")
                        TXports="3"
                        command_string_tx="udc_s_trx2_tx" #IF2a is tx and rx
                        ;;
                    "4")
                        TXports="4"
                        command_string_tx="udc_s_tx_2"     #IF2b is tx only
                        ;;
                    "2,4")
                        TXports="2,4"
                        command_string_tx="udc_s_tx_1,udc_s_tx_2" # Case used in Delivery script
                        ;;
                    "1,3")
                        TXports="1,3"
                        command_string_tx="udc_s_trx1_tx,udc_s_trx2_tx" 
                        ;;
                    *)
                        Error "unrecognized tx ${CFG_ARGS[$r,2]}"
                        sendToExit "check configuration file in udc_port args"
                        ;;
                    esac

                    case ${CFG_ARGS[$r,3]} in
                    "0" | "default" | "3")
                        RXports="3"
                        command_string_rx="udc_s_trx2_rx" #IF2a is tx and rx. Choose for RX
                        if [[ "$TXports" == *"3"* ]] || [[ "$TXports" == *"4"* ]] ; then
                            Error "conflicting tx $TXports and rx $RXports ports"
                            sendToExit "check configuration file in udc_port args"
                        fi
                        ;;
                    "1")
                        RXports="1"
                        command_string_rx="udc_s_trx1_rx" #IF1a is tx and rx. Choose for RX
                        if [[ "$TXports" == *"1"* ]] || [[ "$TXports" == *"2"* ]] ; then
                            Error "conflicting tx $TXports and rx $RXports ports"
                            sendToExit "check configuration file in udc_port args"
                        fi
                        ;;
                    "1,3")
                        RXports="1,3"
                        command_string_rx="udc_s_trx1_rx,udc_s_trx2_rx"
                        if ! [[ "$TXports" == *"na"* ]] ; then
                            Error "conflicting tx $TXports and rx $RXports ports"
                            sendToExit "check configuration file in udc_port args"
                        fi
                        ;;
                    *)
                        Error "unrecognized rx ${CFG_ARGS[$r,3]}"
                        sendToExit "check configuration file in udc_port args"
                        ;;
                    esac

                    if [ $selected_udc_type -eq 0 ] ; then
                       c=0
                    elif [ $selected_udc_type -eq 1 ] ; then
                       c=1
                    fi

                    if [[ $command_string_tx != "" ]] ; then
                        ApplyPorts "$command_string_tx" "$c" "$r"
                    fi

                    if [[ $command_string_rx != "" ]] ; then
                        ApplyPorts "$command_string_rx" "$c" "$r"
                    fi

                elif [ $selected_udc_type -eq 4 ] ||  [ $selected_udc_type -eq 5 ] ; then
                    c=$selected_udc_type
                    trx_command_string=""
                    FillTRX4Ch ${CFG_ARGS[$r,2]} ${CFG_ARGS[$r,3]}
                    ComposeUDCB4TRXCommand "trx_command_string"

                    if [[ "${UDC_current_port1,,}" == *"${TRX_4_CH[0]}"* ]] && [[ "${UDC_current_port2,,}" == *"${TRX_4_CH[1]}"* ]] && [[ "${UDC_current_port3,,}" == *"${TRX_4_CH[2]}"* ]] && [[ "${UDC_current_port4,,}" == *"${TRX_4_CH[3]}"* ]]; then
                        Debug "UDC ports already configured"
                    else
                        ApplyPorts "$trx_command_string" "$c" "$r"
                    fi
                elif [ $selected_udc_type -eq 2 ] || [ $selected_udc_type -eq 3 ] ; then
                   # UDC A. Can configure TX and RX through XMM parameter
                   case ${CFG_ARGS[$r,2]} in
                    "0" | "default" | "1")
                        TXports="1"
                        XMM="2"
                        Debug "configure tx port 1 for UDC ${CFG_ARGS[$r,0]}"
                        ;;
                    "2")
                        TXports="2"
                        XMM="3" 
                        Debug "configure tx port 2 for UDC ${CFG_ARGS[$r,0]}"
                        ;;
                    *)
                        Error "unrecognized tx ${CFG_ARGS[$r,2]}"
                        sendToExit "check configuration file in udc_port args"
                        ;;
                    esac

                    case ${CFG_ARGS[$r,3]} in
                    "0" | "default" | "2")
                        RXports="2"
                        if [[ "$TXports" == *"2"* ]] ; then
                            Error "conflicting tx $TXports and rx $RXports ports"
                            sendToExit "check configuration file in udc_port args"
                        fi
                        XMM="2"
                        Debug "configure rx port 2 for UDC ${CFG_ARGS[$r,0]}"
                        ;;
                    "1")
                        RXports="1"
                        if [[ "$TXports" == *"1"* ]] ; then
                            Error "conflicting tx $TXports and rx $RXports ports"
                            sendToExit "check configuration file in udc_port args"
                        fi
                        XMM="3" 
                        Debug "configure rx port 1 for UDC ${CFG_ARGS[$r,0]}"
                        ;;
                    *)
                        Error "unrecognized rx ${CFG_ARGS[$r,3]}"
                        sendToExit "check configuration file in udc_port args"
                        ;;
                    esac
                fi
            fi
        fi
    done
}

CheckLORange(){
    local __use_LO=$1
    local lo_to_check=$2
    local is_lo_from_cfg=$3
    local flag="false"

    if [ "$lo_to_check" -lt "${datasheets[$selected_udc_type,3]}" ] ; then
        if [[ "$is_lo_from_cfg" == "true" ]] ; then 
            Error "cannot use LO = $lo_to_check lower than UDC capability ${datasheets[$selected_udc_type,3]} Hz"
            sendToExit "check configuration file in udc_port lo"
        fi
        flag="true"
    fi
    if [ "$lo_to_check" -gt "${datasheets[$selected_udc_type,4]}" ] ; then
        if [[ "$is_lo_from_cfg" == "true" ]] ; then 
            Error "cannot use LO = $lo_to_check higher than UDC capability ${datasheets[$selected_udc_type,4]} Hz"
            sendToExit "check configuration file in udc_port lo"
        fi
        flag="true"
    fi
    local modulus=$((lo_to_check%4000000))
    if [ $selected_udc_type -eq 2 ] || [ $selected_udc_type -eq 3 ] ; then
        if [ $modulus -ne 0 ] ; then
            #Debug "LO = $lo_to_check does not respect UDC A requirements. LO not divisible by 4MHz."
            flag="true"
        fi
    fi

    eval $__use_LO="'$flag'"
}


EnquiryFreqTable(){
    local target_freq=$1
    local __result_if=$2

    length=$((${#FORBIDDEN_FREQ[@]}))
    for (( row=0; row<${length}-1; row++ ));
    do 
        central_forbidden=${FORBIDDEN_FREQ[$row,0]}
        min_forbidden=$(($central_forbidden-$delta))
        max_forbidden=$(($central_forbidden+$delta))

        if [ $target_freq -gt $min_forbidden ] && [ $target_freq -lt $max_forbidden ] ; then
            #Debug "WARNING Freq: $target_freq is in non optimal interval [$min_forbidden;$max_forbidden]"
            eval $__result_if=-1
        else
            #Debug "Freq: $target_freq outside of interval [$min_forbidden;$max_forbidden]"
            eval $__result_if=1
        fi

        if [ $max_forbidden -gt $target_freq ] ; then
            break
        fi
    done
}

FindLOLoop(){

    local _start_lo=$1
    local _enquiryIFTable=$2

    local result_if=1
    local lo_nok="false"

    for ((i=$_start_lo; i>=${datasheets[$selected_udc_type,3]}; i-=1000000))
    do
        #echo "~~ Analyse LO = $i" 

        for fr2f in "${FR2_FREQS[@]}"
        do
            # Nomal case. Use the computation to find a good fit
            computed_if=$(($fr2f-$i))
            if [ $computed_if -lt ${datasheets[$selected_udc_type,5]} ] || [ $computed_if -gt ${datasheets[$selected_udc_type,6]} ] ; then
                # in case the computed IF freq doesn't fit in the UDC spec change LO to recompute the IF
                break
            fi

            #echo "Analyse LO = $i and IF frequency=$computed_if for RF_freq=$fr2f"
            if [ "$_enquiryIFTable" == "true" ] ; then
                EnquiryFreqTable $computed_if result_if
            fi
            
            if [ $result_if -eq 1 ] ; then
                return_IF+=("$computed_if")
                #echo "print IF found so far: ${return_IF[@]}"
                #echo "LENGTH results array=${#return_IF[@]} . vs length freq array ${#FR2_FREQS[@]}"
                if [ "${#return_IF[@]}" -eq "${#FR2_FREQS[@]}" ] ; then
                    # confirm first that the found LO is ok
                    lo_nok="false"
                    CheckLORange lo_nok $i "false"
                    if [ $lo_nok == "true" ] ; then
                        # need to compute with another lo
                        return_IF+=()
                        break 1
                    else
                        # the lo is ok stop the computations
                        return_LO=$i # give the result to the global variable
                        break 2
                    fi
                fi
            else
                #echo "frequency $result_if was not optimal restart with new LO"
                return_IF=()
                break
            fi
        done
    done
}

LOAutoSel(){

    local string=${FR2_FREQS[0]}
    decimal=${string:5:6}
    d=$((10#$decimal))
    local pref_f=0
    
    if [ $selected_udc_type -eq 1 ] ; then
        pref_f=$(($PrefStart_B39+$d))
    else
        pref_f=$(($PrefStart+$d))
    fi

    local start_lo=$((${FR2_FREQS[0]}-pref_f))
    local lo_nok="false"
    local enquiryIFTable="true"
    
    CheckLORange lo_nok $start_lo "false"
    # if the computed lo in ok proceed by 
    if [ $lo_nok == "true" ] ; then
        start_lo=${datasheets[$selected_udc_type,4]} # Start with UDC highest possible LO
    fi

    FindLOLoop $start_lo $enquiryIFTable

    if [ "${#return_IF[@]}" -lt "${#FR2_FREQS[@]}" ] ; then
        # fallback case ignore the SDR performance IF table
        Debug "compute LO fallback case: ignoring IFs"
        enquiryIFTable="false"
        FindLOLoop $start_lo $enquiryIFTable
    fi
}


SetLO(){
    local use_auto_LO="true"
    local result_if=-1
    local lo_from_cfg="false"
    Debug "set LO:"
    if [ $LO -ne 0 ] ; then
        # try to use the LO passed as argument of the script
        lo_from_cfg="true"
        CheckLORange use_auto_LO $LO $lo_from_cfg
        if [[ "$use_auto_LO" == "false" ]] && [[ "$delivery" == "false" ]] ; then
            for fr2f in "${FR2_FREQS[@]}"
            do
                deduce_IF=$(($fr2f-$LO)) 
                # Even if the deduced IF freq is in the forbidden interval just print a warning.
                # In this case we need to use the LO imposed 
                EnquiryFreqTable $deduce_IF result_if
                return_IF+=("$deduce_IF")
            done
        fi
        return_LO=$LO
    fi
    if [[ "$use_auto_LO" == "true" ]] && [[ "$delivery" == "false" ]] ; then
        LOAutoSel
    fi

    # Send now to each UDC the command set the LO
    # So far the LO is re-configured each time the script is called.
    # For UDC B4 we could check already what is the configured LO 
    # and send the command only if the UDC is not yet configured with the same LO
    local LO_MHz=$(bc <<< "scale=6;$return_LO/1000000") 
    local LO_GHz=$(bc <<< "scale=9; $return_LO/1000000000") 

    local modulus=$(bc <<< "scale=6;$LO_MHz%4")
    if [ $modulus -eq 0 ] ; then
        local LO_div4MHz=$(bc <<< "$LO_MHz/4") 
        local LO_div4Hex=$(bc <<< "obase=16; ibase=10; $LO_div4MHz")
    fi
    local cmd_lo_str=""
    local cmd_lo2_str=""
    local params=""

    if [ $selected_udc_type -eq 0 ] ; then
        c=0
        cmd_lo_str2="udc_s_exlo_init" # command for slave UDC
        cmd_lo_str="udc_w_lo_in_$LO_GHz"
        params=""
    elif [ $selected_udc_type -eq 1 ] ; then
        c=1
        cmd_lo_str2="udc_s_exlo_init" # command for slave UDC
        cmd_lo_str="udc_w_lo_in_$LO_GHz"
        params=""
    elif [ $selected_udc_type -eq 2 ] ; then
        c=2
        cmd_lo_str="XFF"
        params=" $LO_div4Hex\r\n"
    elif [ $selected_udc_type -eq 3 ] ; then
        c=3
        cmd_lo_str="XFF"
        params=" $LO_div4Hex\r\n"
    elif [ $selected_udc_type -eq 4 ] ; then
        c=4
        cmd_lo_str="udc_s_lo"
        params=" $LO_GHz"
    elif [ $selected_udc_type -eq 5 ] ; then
        c=5
        cmd_lo_str="udc_s_lo"
        params=" $LO_GHz"
    else
        sendToExit "unrecognized udc type"
    fi


    #set TX port for each matched UDC B2
    for r in ${rows[@]} ;
    do
        if [[ "0" == "${MATCH_DEVS[$r,$c]}" ]] ; then
                Debug "UDC LO configuration completed"
                break
        else
            if [[  "${MATCH_DEVS[$r,$c]}" == "${CFG_ARGS[$r,0]}" ]] ; then
                if [ $selected_udc_type -eq 0 ] || [ $selected_udc_type -eq 1 ] ; then
                    if [[  "${CFG_ARGS[$r,1]}" == "external" ]] ; then
                        sendInstruction "$cmd_lo_str2" "$params" ${MATCH_DEVS[$r,$c]}
                    else
                        sendInstruction "$cmd_lo_str" "$params" ${MATCH_DEVS[$r,$c]}
                    fi
                elif  [ $selected_udc_type -eq 4 ] || [ $selected_udc_type -eq 5 ] ; then 
                    if [ $return_LO -eq $UDC_current_lo ] ; then 
                        Debug "LO $return_LO is already configured"
                    else
                        sendInstruction "$cmd_lo_str" "$params" ${MATCH_DEVS[$r,$c]}
                    fi
                    sendInstruction "udc_r_status" "" ${MATCH_DEVS[$r,$c]}
                elif [ $selected_udc_type -eq 2 ] || [ $selected_udc_type -eq 3 ] ; then
                    # For UDC type A is required to send 3 commands
                    sendInstruction "XMM $XMM" "\r\n" ${MATCH_DEVS[$r,$c]}
                    sendInstruction "$cmd_lo_str" "$params" ${MATCH_DEVS[$r,$c]}
                    sendInstruction "U0" "\r\n" ${MATCH_DEVS[$r,$c]} # U0 command is to check if the XFF entered properly
                fi
            fi
        fi
    done
}

FirmwareCheck(){
    if [[ "$read_fw_ver" == *"$FW_Check"* ]] ; then
        Debug "FW matching, expected $FW_Check corresponds to $read_fw_ver"
    else 
        Error "FW NOT matching, expected $FW_Check does not corresponds to $read_fw_ver"
        sendToExit "FW NOT matching"
    fi
    # just checking if the firmware is up to date and then exit the test
    Debug "FW check terminated"
    exit 0
}

DisableSignalStop(){
# for UDC B4 37-48 disable the automatic signal stop when getting closer to saturation
# by default the UDC cuts the transmission when it gets close to the saturation point
    if [ $selected_udc_type -eq 5 ]; then
        Debug "UDC B4 37-48 disable signal stop:"
        for r in ${rows[@]} ;
        do
            if [[ "0" == "${MATCH_DEVS[$r,$selected_udc_type]}" ]] ; then
                break
            else
                sendInstruction "udc_w_amp-monitor off" "$params" ${MATCH_DEVS[$r,$selected_udc_type]}
            fi
        done
    else
        Debug "UDC does not support signal stop function"
    fi
}

CalibrateUDC(){
    if [ $selected_udc_type -eq 4 ] || [ $selected_udc_type -eq 5 ]; then
        Debug "UDC calibration:"
        for r in ${rows[@]} ;
        do
            if [[ "0" == "${MATCH_DEVS[$r,$selected_udc_type]}" ]] ; then
                break
            else
                sendInstruction "udc_w_ckg-calib on" "$params" ${MATCH_DEVS[$r,$selected_udc_type]}
                if [[ "$calibration_done" == "true" ]] ; then
                    Debug "calibration completed"
                else 
                    Error "cannot calibrate, check GPS source"
                    sendToExit "cannot calibrate, check GPS source"
                fi
                sendInstruction "udc_s_save-all" "$params" ${MATCH_DEVS[$r,$selected_udc_type]}
                if [[ "$eprom_done" == "true" ]] ; then
                    Debug "calibration saved in eeprom"
                else 
                    Error "cannot save calibration"
                    sendToExit "calibration not saved in erpom"
                fi
            fi
        done
    else 
        Debug "UDC does not support calibration"
    fi
    # just checking if the firmware is up to date and then exit the test
    Debug "exit after calibration finished"
    exit 0
}


SetMaxPower(){
    # Example Enter in the UDC with -32dBm total power
    # The sum of al the CC sould not exceed -32dBm
    # Power equally distributed among the cells

    # power_level is the suitable point to use the UDC +some margin 
    # the idea is to give a value of the TXpower that does not saturate the UDC
    # Because it will allow to tune the max TX gain to clip in the mmWave CC rf_port keep some dB higher


    n_cells=${#FR2_FREQS[@]}
    power_level=${datasheets[$selected_udc_type,8]}  # Maximum power level to enter the UDC IF port
    tolerance_error=${datasheets[$selected_udc_type,9]} #Maximum tolerance error for the power estimation
    exponent=$(bc <<< "scale=20; ($power_level+$tolerance_error)/10")
    tot_pow_W=$(echo "" | awk 'END {print (10) ^ ('"$exponent"') }')
    pow_per_cc_W=$(echo "" | awk 'END {print ('"$tot_pow_W"') / ('"$n_cells"') }')   
    pow_per_cc_dBm=$(echo "" | awk 'END {print 10*(log('"$pow_per_cc_W"')/log(10)) }')  

    for ((i=0; i<$n_cells; i++))
    do
	 return_TX_POWER_MAX+=("$pow_per_cc_dBm")
    done
}

UDC_current_status(){
    local column=999 # column corresponding to udc type B428
    udc_status_lines=()
    if [ $selected_udc_type -eq 4 ] || [ $selected_udc_type -eq 5 ]; then
        Debug "UDC current status:"
        if [[  ${#a[@]} -gt 1 ]] ; then
            Error "cannot have more than one UDC B4 in the same udc_port"
            sendToExit "too many UDCs in the same udc_port"
        fi

        column=$selected_udc_type
        for r in ${rows[@]} ;
        do
            if [[  "0" == "${MATCH_DEVS[$r,$column]}" ]] ; then
                break
            else
                sendInstruction "udc_r_status" "" ${MATCH_DEVS[$r,$column]}

                for l in "${udc_status_lines[@]}" ;
                do
                    if [[ "$l" == *"Channel 1  Status"* ]] ; then
                        UDC_current_port1=${l#*:}
                        UDC_current_port1=$(echo ${UDC_current_port1//[[:blank:]]/})
                        UDC_current_port1="${UDC_current_port1,,}"
                    elif [[ "$l" == *"Channel 2  Status"* ]] ; then
                        UDC_current_port2=${l#*:}
                        UDC_current_port2=$(echo ${UDC_current_port2//[[:blank:]]/})
                        UDC_current_port2="${UDC_current_port2,,}"
                    elif [[ "$l" == *"Channel 3  Status"* ]] ; then
                        UDC_current_port3=${l#*:}
                        UDC_current_port3=$(echo ${UDC_current_port3//[[:blank:]]/})
                        UDC_current_port3="${UDC_current_port3,,}"
                    elif [[ "$l" == *"Channel 4  Status"* ]] ; then
                        UDC_current_port4=${l#*:}
                        UDC_current_port4=$(echo ${UDC_current_port4//[[:blank:]]/})
                        UDC_current_port4="${UDC_current_port4,,}"
                    elif [[ "$l" == *"Lo"* ]] ; then
                        UDC_current_lo=${l#*:}
                        UDC_current_lo=$(echo ${UDC_current_lo//[[:blank:]]/})
                        UDC_current_lo=$(echo "${UDC_current_lo%%.*}")
                    elif [[ "$l" == *"Configured clock source"* ]] ; then
                        UDC_current_clock=${l#*:}
                        UDC_current_clock=$(echo ${UDC_current_clock//[[:blank:]]/})
                    fi
                done
            fi
        done
    #elif [ $selected_udc_type -eq 2 ] || [ $selected_udc_type -eq 3 ] ; then
    #    column=$selected_udc_type
    #    sendInstruction "U0" "\r\n" ${MATCH_DEVS[$r,$column]} # U0 command is to check the actual status

    #else
        #Debug "Selceted udc type $selected_udc_type does not have the funcionality to return the configuration resume"
    fi

}

CheckDevString() {
    local dev_string=$1
    if ! [[ $dev_string =~ ^/dev/tty[A-Z]+[0-9]+$ ]] ; then
        Error "device argument malformed in args string: $dev_string"
        sendToExit "check configuration file in udc_port args"
    fi
}

CheckClockString(){
    local clock_string=$1
    if ! [[ $clock_string =~ ^clock=[a-z]+$ ]] ; then
        Error "clock argument malformed in args string: $clock_string"
        sendToExit "check configuration file in udc_port args"
    fi
}

CheckTxRxString(){
    local string=$1
    local txrx=$2
    if ! [[ "$string" =~ ^$txrx=(default|([1-4](,[1-4]){0,3}))$ ]]; then
            Error "$txrx argument malformed in args string: $string"
            sendToExit "check configuration file in udc_port args"
    fi

}

# ---------------------------------
# Code Body
# ---------------------------------

#Check if bad separators
if ! [[ $ARGS =~ [a-zA-Z] ]] ; then 
    Error "args does not contain letters, certainly malformed args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

if ! [[ $ARGS =~ [0-9] ]] ; then
    Error "args does not contain numbers, make sure to specify /dev/tty<enumeration> in args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

if [[ $ARGS == *[\(\)\`\~\!\@\#\$\%\^\&\*\-\+\|\\\{\}\[\]\:\"\'\<\>\.\?\_\.]* ]] ; then
    Error "args contains one or more forbidden char ()\`~!@#$%^&*-+|\{}[]:\"\'<>.?_. check in args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

if [[ $ARGS = *" "* ]] ; then
    Error "args contains spaces check in args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

# Split the args string following ; separator
readarray -d ';' -t LIST <<< "$ARGS"
if [ ${#LIST[@]} -eq 0 ]; then
    usage "missing arguments"
fi

# Divide args to identify dev/tty , clock and ports
row_count=-1
string=""
dv_count=0
ck_count=0
tx_count=0
rx_count=0
for l in "${LIST[@]}"; do
    l=${l//$'\n'/} # Remove all newlines.
    if [[ "$l,," == *"tty"* ]] || [[ "$l" == *"/"* ]] || [[ "$l,," == *"dev"* ]] || [[ "$l,," == *"usb"* ]] || [[ "$l,," == *"acm"* ]]; then
        CheckDevString "$l"
        row_count=$((row_count+1))
        dv_count=$((dv_count+1))
        CFG_ARGS[$row_count,0]="${l#*=}"
    elif [[ "$l,," == *"clock"* ]] && [[ "$row_count" -gt -1 ]] ; then
        CheckClockString "$l"
        ck_count=$((ck_count+1))
        CFG_ARGS[$row_count,1]="${l#*=}"
    elif [[ "$l,," == *"tx"* ]] && [[ "$row_count" -gt -1 ]] ; then
        CheckTxRxString "$l" "tx"
        tx_count=$((tx_count+1))
        CFG_ARGS[$row_count,2]="${l#*=}"
    elif [[ "$l,," == *"rx"* ]] && [[ "$row_count" -gt -1 ]] ; then
        CheckTxRxString "$l" "rx"
        rx_count=$((rx_count+1))
        CFG_ARGS[$row_count,3]="${l#*=}"
    fi
done

if [ "$row_count" -eq -1 ]; then
    Error "any specified /dev/ in args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

if [ "$ck_count" -gt "$dv_count" ]; then
    Error "clock specified $ck_count times but only $dv_count devices in args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

if [ "$tx_count" -gt "$dv_count" ]; then
    Error "tx specified $tx_count times but only $dv_count devices in args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

if [ "$rx_count" -gt "$dv_count" ]; then
    Error "rx specified $rx_count times but only $dv_count devices in args string: $ARGS"
    sendToExit "check configuration file in udc_port args"
fi

# Resume Input arguments
Debug "input parameters from config file:"
for r in ${rows[@]} ;
do
    if [[  "0" == "${CFG_ARGS[$r,0]}" ]] ; then
        break
    else
        Debug "DEV ARG : "${CFG_ARGS[$r,0]}
        Debug "Clock   : "${CFG_ARGS[$r,1]}
        Debug "Tx      : "${CFG_ARGS[$r,2]}
        Debug "Rx      : "${CFG_ARGS[$r,3]}
    fi
done

Debug "FR2_RFs : "$FR2_RFs
Debug "MIN_FREQ: "$MIN_FREQ
Debug "MAX_FREQ: "$MAX_FREQ
Debug "LO      : "$LO 
if [[  "$delivery" == "true" ]] ; then
    Debug "FW      : "$FW_Check
    Debug "CAL     : "$calibrate
fi

if [[  "$FW_Check" == "" ]] && [[  "$calibrate" == "false" ]]; then
    # Split FR2 frequencies argument 
    IFS=';' read -ra FR2_FREQS <<< "$FR2_RFs"
    #readarray -d ';' -t FR2_FREQS <<< "$FR2_RFs"
    if [ ${#FR2_FREQS[@]} -eq 0 ]; then
        usage "missing arguments"
    fi
fi

# Auto detects the UDC type querying the USB ports
AutoDetectDevice 

# Determine if the auto detected UDC corresponds to the listed argument
for r in ${rows[@]} ;
do
    if [[  "${CFG_ARGS[$r,0]}" == "0" ]] ; then
        break
    else
        CheckArg ${CFG_ARGS[$r,0]}
    fi
done

# Firmware version check if option specified
if [[  "$FW_Check" != "" ]] ; then
    FirmwareCheck
fi


# Check if the number and type of specified UDC are compatible in a real setup 
SetupCheck

# Firmware version check if option specified
if [[  "$calibrate" == "true" ]] ; then
    CalibrateUDC
fi



# Check the current configuration of the UDC.
# For now valid only for UDC B4 24-30 and B4 37-48
# B2 does not support it
# A2 can support check on the LO only
UDC_current_status 

# Check whether if the configured RF corresponds to detected UDC datasheet
if [[  "$delivery" == "false" ]] ; then
    CheckRFs
fi

# Setting functions
SetClock
SetTXRXPorts
SetLO

if  [ $selected_udc_type -eq 4 ] || [ $selected_udc_type -eq 5 ]; then
    if [ "$effective_clock_sourceB4" != "$configured_clock_sourceB4" ] ; then
        Error "error in clock configuration"
        sendToExit "mismatching clock sources"
    fi
fi

# if UDC B4 37-48 need to disable the auto signal stop when close to saturation
if  [ $selected_udc_type -eq 5 ]; then
    DisableSignalStop
fi

if [[  "$delivery" == "false" ]] ; then
    SetMaxPower
fi

Log "UDC configuration terminated"

if [[  "$delivery" == "false" ]] ; then
    # Output for enb caller
    echo "LO_FREQ=$return_LO"
    echo "TX_POWER_OFFSET=$return_TX_POWER_OFFSET"
    c=0
    for pwr in "${return_TX_POWER_MAX[@]}"; do
	    echo "TX_POWER_MAX$c=$pwr"
	    c=$(($c+1))
    done
    c=0
    for iff in "${return_IF[@]}"; do
       echo "IF$c=$iff"
       c=$(($c+1))
    done
    c=0
    for pwr in "${return_TX_POWER_MAX[@]}"; do
       echo "TX_GAIN_MARGIN$c=$return_TX_GAIN_MARGIN"
       c=$(($c+1))
    done
fi

exec 3<&-
exit 0
