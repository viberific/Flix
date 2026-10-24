package com.viberific.flix.car;

import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.validation.HostValidator;

/**
 * Flix on the car screen (Android Auto), for a car that is standing still. This is the only entry point of the car
 * side of the app; the phone and TV app (MainActivity) never touches it and works the same without it.
 */
public class FlixCarService extends CarAppService {
    @NonNull
    @Override
    public HostValidator createHostValidator() {
        // This build is meant to be sideloaded with Android Auto's developer mode ("Unknown sources"), where the
        // host is not the Play-signed one, so every host is accepted.
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
    }

    @NonNull
    @Override
    public Session onCreateSession() {
        return new Session() {
            @NonNull
            @Override
            public Screen onCreateScreen(@NonNull Intent intent) {
                return new FlixScreen(getCarContext());
            }
        };
    }
}
